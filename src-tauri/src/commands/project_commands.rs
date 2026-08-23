use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::save::{SaveProgress, SaveProjectRequest};
use crate::services::project_service::{OpenProjectResult, ProjectService};
use crate::state::AppState;

#[tauri::command]
pub fn init_project(state: State<'_, AppState>) -> Result<ProjectInfo, AppError> {
    let service = ProjectService::new(&state);
    service.init_project()
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    file_path: String,
) -> Result<ProjectInfo, AppError> {
    let service = ProjectService::new(&state);
    service.create_project(&name, &file_path)
}

#[tauri::command(async)]
pub fn open_project(
    state: State<'_, AppState>,
    app: AppHandle,
    file_path: String,
) -> Result<OpenProjectResult, AppError> {
    let service = ProjectService::new(&state);
    service.open_project(
        &file_path,
        Some(&|ds_idx, ds_total, ds_name, rows_done, rows_total| {
            let _ = app.emit(
                "open-project-progress",
                serde_json::json!({
                    "datasetIndex": ds_idx,
                    "datasetTotal": ds_total,
                    "datasetName": ds_name,
                    "rowsDone": rows_done,
                    "rowsTotal": rows_total,
                }),
            );
        }),
    )
}

#[tauri::command(async)]
pub async fn save_project(
    state: State<'_, AppState>,
    request: SaveProjectRequest,
    on_progress: Channel<SaveProgress>,
) -> Result<ProjectInfo, AppError> {
    let state_ref: &AppState = &state;
    std::thread::scope(|scope| {
        let handle = scope.spawn(move || {
            let service = ProjectService::new(state_ref);
            service.save_project(
                request,
                Some(&|progress| {
                    let _ = on_progress.send(progress);
                }),
            )
        });

        handle
            .join()
            .map_err(|_| AppError::Busy("Save worker thread panicked".to_string()))?
    })
}

#[tauri::command]
pub fn get_current_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, AppError> {
    let service = ProjectService::new(&state);
    service.get_current_project()
}

// ----------------------------------------------------------------------------
// Single-table / single-graph share commands.
// .sptb = standalone table file (one dataset), .spgh = standalone graph file.
// ----------------------------------------------------------------------------

#[tauri::command]
pub fn export_table(
    state: State<'_, AppState>,
    dataset_id: String,
    file_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    service.export_table(&dataset_id, &file_path)
}

/// Export multiple datasets to a single `.zip` of `.sptb` files. The optional
/// `archive_paths` map provides `dataset_id → path inside the zip` (without
/// `.sptb`) so the UI can mirror its folder tree. Missing entries fall back
/// to the dataset's plain name at the zip root.
#[tauri::command(async)]
pub fn export_tables_sptb_zip(
    state: State<'_, AppState>,
    dataset_ids: Vec<String>,
    archive_paths: Option<std::collections::HashMap<String, String>>,
    output_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    let paths = archive_paths.unwrap_or_default();
    service.export_tables_sptb_zip(&dataset_ids, &paths, &output_path)
}

/// Result of importing a standalone `.sptb` into the current project.
/// Per issue #7 the `.sptb` body no longer carries folder info — the imported
/// table lands wherever the caller decides (root by default).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTableResult {
    pub id: String,
}

/// Returns the new dataset id assigned to the imported table.
#[tauri::command(async)]
pub fn import_table(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ImportTableResult, AppError> {
    let service = ProjectService::new(&state);
    let id = service.import_table(&file_path)?;
    Ok(ImportTableResult { id })
}

#[tauri::command]
pub fn export_graph(
    state: State<'_, AppState>,
    graph: serde_json::Value,
    file_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    service.export_graph(graph, &file_path)
}

/// Returns the imported graph builder body (opaque JSON, frontend shape).
#[tauri::command]
pub fn import_graph(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let service = ProjectService::new(&state);
    service.import_graph(&file_path)
}

#[cfg(test)]
mod tests {
    fn function_signature(source: &str, function_name: &str) -> String {
        let start = source
            .find(function_name)
            .unwrap_or_else(|| panic!("{function_name} command must exist"));
        let rest = &source[start..];
        let end = rest
            .find(") ->")
            .unwrap_or_else(|| panic!("{function_name} signature must contain a return type"));
        rest[..end + 1].to_string()
    }

    #[test]
    fn project_open_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let open_start = source
            .find("pub fn open_project(")
            .expect("open_project command must exist");
        let command_attribute = &source[..open_start];

        assert!(
            command_attribute.trim_end().ends_with("#[tauri::command(async)]"),
            "open_project must not run archive and database work on Tauri's main command thread"
        );
    }

    #[test]
    fn sptb_import_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let import_start = source
            .find("pub fn import_table(")
            .expect("import_table command must exist");
        let command_attribute = &source[..import_start];

        assert!(
            command_attribute.trim_end().ends_with("#[tauri::command(async)]"),
            "import_table must not run blocking archive and database work on Tauri's main command thread"
        );
    }

    #[test]
    fn project_save_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let save_start = source
            .find("pub async fn save_project(")
            .expect("save_project command must exist");
        let command_attribute = &source[..save_start];

        assert!(
            command_attribute
                .trim_end()
                .ends_with("#[tauri::command(async)]"),
            "save_project must run off the Tauri main command thread"
        );
    }

    #[test]
    fn project_save_accepts_only_request_and_progress_channel() {
        let source = include_str!("project_commands.rs");
        let signature = function_signature(source, "pub async fn save_project(");

        assert!(
            signature.contains("request: SaveProjectRequest"),
            "save_project must accept one typed SaveProjectRequest object"
        );
        assert!(
            signature.contains("on_progress: Channel<SaveProgress>"),
            "save_project must accept a progress channel"
        );
        assert!(
            !signature.contains("file_path:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("history:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("snapshots:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("graph_builders:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("tabulates:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("table_folders:"),
            "legacy loose save arguments must be removed from save_project"
        );
    }

    #[test]
    fn project_save_ignores_progress_channel_send_failures() {
        let source = include_str!("project_commands.rs");
        let body = source
            .split("pub async fn save_project(")
            .nth(1)
            .expect("save_project command must exist");

        assert!(
            body.contains("let _ = on_progress.send(progress);") ,
            "save_project progress callback must ignore channel send failures"
        );
    }
}
