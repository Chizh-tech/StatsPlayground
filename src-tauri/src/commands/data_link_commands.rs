use std::collections::HashSet;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::models::data_link::{PreviewResult, SourceObject, SqliteImportSelection};
use crate::models::table::DatasetMeta;
use crate::services::data_link_service::DataLinkService;
use crate::services::io_service::IoService;
use crate::state::AppState;

#[derive(Clone, Serialize)]
struct ImportProgress {
    table_name: String,
    table_index: usize,
    table_total: usize,
    rows_done: usize,
    rows_total: usize,
}

#[tauri::command(async)]
pub async fn list_sqlite_source_objects(
    file_path: String,
) -> Result<Vec<SourceObject>, AppError> {
    tokio::task::spawn_blocking(move || DataLinkService::list_sqlite_objects(&file_path))
        .await
        .map_err(|error| AppError::Database(format!("DataLink worker failed: {error}")))?
}

#[tauri::command(async)]
pub async fn preview_sqlite_source_object(
    file_path: String,
    object_name: String,
    limit: usize,
) -> Result<PreviewResult, AppError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::preview_sqlite_object(&file_path, &object_name, limit)
    })
    .await
    .map_err(|error| AppError::Database(format!("DataLink worker failed: {error}")))?
}

#[tauri::command(async)]
pub fn import_selected_sqlite(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    selections: Vec<SqliteImportSelection>,
) -> Result<Vec<DatasetMeta>, AppError> {
    if selections.is_empty() {
        return Err(AppError::InvalidParam(
            "Select at least one SQLite table".to_string(),
        ));
    }

    let mut source_names = HashSet::new();
    let mut target_names = HashSet::new();
    for selection in &selections {
        if selection.action != "create" && selection.action != "append" {
            return Err(AppError::InvalidParam(format!(
                "Unsupported SQLite import action: {}",
                selection.action
            )));
        }
        if !source_names.insert(selection.source_name.to_lowercase()) {
            return Err(AppError::InvalidParam(format!(
                "SQLite table selected more than once: {}",
                selection.source_name
            )));
        }
        if selection.action == "create"
            && !target_names.insert(selection.target_name.to_lowercase())
        {
            return Err(AppError::InvalidParam(format!(
                "Duplicate target dataset name: {}",
                selection.target_name
            )));
        }
    }

    let _permit = crate::commands::io_commands::acquire_mutation_permit(state.inner())?;
    let pairs = selections
        .into_iter()
        .map(|selection| {
            (
                selection.source_name,
                selection.target_name,
                selection.action == "append",
            )
        })
        .collect::<Vec<_>>();
    IoService::new(state.inner()).import_selected_sqlite(
        &file_path,
        &pairs,
        |table_name, table_index, table_total, rows_done, rows_total| {
            let _ = app.emit(
                "import-progress",
                ImportProgress {
                    table_name: table_name.to_string(),
                    table_index,
                    table_total,
                    rows_done,
                    rows_total,
                },
            );
        },
    )
}
