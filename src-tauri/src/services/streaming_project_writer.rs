use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::engine::duckdb_engine::ArchiveKeysetReadPlan;
use crate::error::AppError;
use crate::models::save::{
    SavePhase, SaveProgress, SaveProgressCallback, SaveSnapshot, SaveWriteResult,
};
use crate::models::table::ColumnDisplayProps;
use crate::services::archive_cell::write_archive_cell;
use crate::services::save_coordinator::SaveGuard;
use crate::services::spprj_archive::{
    self, GraphDoc, ProjectManifest, TableColumn, TableColumnFormat, TableDoc,
};
use crate::state::AppState;

const STREAM_VERSION: &str = "3.0.0";
const TABLE_DOC_VERSION: &str = "2";
const TARGET_BATCH_BYTES: usize = 4 * 1024 * 1024;
const HARD_BATCH_BYTES: usize = 8 * 1024 * 1024;
const ROW_LIMIT_PER_BATCH: usize = 2048;
const PROGRESS_MIN_INTERVAL_MS: u64 = 100;
const PROGRESS_MAX_INTERVAL_MS: u64 = 250;

trait SaveClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

struct SystemClock {
    started: Instant,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl SaveClock for SystemClock {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

#[derive(Default)]
struct RowProgressThrottle {
    first_checkpoint_ms: Option<u64>,
    last_emit_ms: Option<u64>,
}

impl RowProgressThrottle {
    fn should_emit(&mut self, now_ms: u64, force: bool) -> bool {
        if force {
            self.last_emit_ms = Some(now_ms);
            return true;
        }

        match self.last_emit_ms {
            None => {
                let first_checkpoint_ms = self.first_checkpoint_ms.get_or_insert(now_ms);
                let elapsed = now_ms.saturating_sub(*first_checkpoint_ms);
                if elapsed >= PROGRESS_MIN_INTERVAL_MS {
                    self.last_emit_ms = Some(now_ms);
                    true
                } else {
                    false
                }
            }
            Some(last_emit_ms) => {
                let elapsed = now_ms.saturating_sub(last_emit_ms);
                // Progress is checkpoint-driven: we only emit while rows are
                // actually advancing at row checkpoints.
                if elapsed >= PROGRESS_MAX_INTERVAL_MS {
                    self.last_emit_ms = Some(now_ms);
                    true
                } else if elapsed >= PROGRESS_MIN_INTERVAL_MS {
                    self.last_emit_ms = Some(now_ms);
                    true
                } else {
                    false
                }
            }
        }
    }
}

trait ArchiveReplacer: Send + Sync {
    fn replace_archive(&self, temp_path: &Path, destination_path: &Path) -> Result<(), AppError>;
}

struct OsArchiveReplacer;

impl ArchiveReplacer for OsArchiveReplacer {
    fn replace_archive(&self, temp_path: &Path, destination_path: &Path) -> Result<(), AppError> {
        replace_archive_atomically_os(temp_path, destination_path)
    }
}

pub struct StreamingProjectWriter<'state, 'guard> {
    state: &'state AppState,
    _save_guard: &'guard SaveGuard<'state>,
    clock: Arc<dyn SaveClock>,
    replacer: Arc<dyn ArchiveReplacer>,
}

impl<'state, 'guard> StreamingProjectWriter<'state, 'guard> {
    pub fn new(state: &'state AppState, save_guard: &'guard SaveGuard<'state>) -> Self {
        Self {
            state,
            _save_guard: save_guard,
            clock: Arc::new(SystemClock::new()),
            replacer: Arc::new(OsArchiveReplacer),
        }
    }

    #[cfg(test)]
    fn with_clock(
        state: &'state AppState,
        save_guard: &'guard SaveGuard<'state>,
        clock: Arc<dyn SaveClock>,
    ) -> Self {
        Self {
            state,
            _save_guard: save_guard,
            clock,
            replacer: Arc::new(OsArchiveReplacer),
        }
    }

    #[cfg(test)]
    fn with_clock_and_replacer(
        state: &'state AppState,
        save_guard: &'guard SaveGuard<'state>,
        clock: Arc<dyn SaveClock>,
        replacer: Arc<dyn ArchiveReplacer>,
    ) -> Self {
        Self {
            state,
            _save_guard: save_guard,
            clock,
            replacer,
        }
    }

    pub fn write(
        &self,
        snapshot: &SaveSnapshot,
        destination_path: &Path,
        progress_cb: Option<&SaveProgressCallback<'_>>,
    ) -> Result<SaveWriteResult, AppError> {
        if snapshot.destination_path != destination_path {
            return Err(AppError::InvalidParam(
                "snapshot destination path and writer destination path must match".to_string(),
            ));
        }
        validate_destination_path(&snapshot.destination_path)?;

        let total_rows = snapshot
            .datasets
            .iter()
            .map(|dataset| usize::try_from(dataset.row_count.max(0)).unwrap_or(usize::MAX))
            .sum::<usize>();

        emit_progress(
            progress_cb,
            SaveProgress {
                phase: SavePhase::Preparing,
                table_index: 0,
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: 0,
                rows_total: total_rows,
                overall_progress: Some(0.0),
            },
        );

        let graph_docs = spprj_archive::build_graph_docs(snapshot.request.graph_builders.clone());
        let placeholder_tables = snapshot
            .datasets
            .iter()
            .map(|dataset| TableDoc {
                id: dataset.id.clone(),
                name: dataset.name.clone(),
                source_type: dataset.source_type.clone(),
                version: TABLE_DOC_VERSION.to_string(),
                columns: Vec::new(),
                rows: Vec::new(),
            })
            .collect::<Vec<_>>();

        let bundle = spprj_archive::build_bundle(
            snapshot.destination_name.clone(),
            STREAM_VERSION.to_string(),
            snapshot.current_project.created_at.clone(),
            placeholder_tables,
            graph_docs,
            snapshot.request.tabulates.clone(),
            snapshot.request.folders.clone(),
            &snapshot.request.table_folders,
            &snapshot.request.graph_folders,
            &snapshot.request.tabulate_folders,
            snapshot.request.history.clone(),
            snapshot.request.snapshots.clone(),
        );

        let temp_path = PathBuf::from(format!("{}.tmp", snapshot.destination_path.to_string_lossy()));
        let run_result = self.write_temp_archive(
            snapshot,
            &bundle.manifest,
            &bundle.graphs,
            &temp_path,
            total_rows,
            progress_cb,
        );

        if let Err(error) = run_result {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }

        if let Err(error) = self
            .replacer
            .replace_archive(&temp_path, &snapshot.destination_path)
        {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }
        let archive_bytes = std::fs::metadata(&snapshot.destination_path)?.len();

        emit_progress(
            progress_cb,
            SaveProgress {
                phase: SavePhase::Finalizing,
                table_index: snapshot.datasets.len(),
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: total_rows,
                rows_total: total_rows,
                overall_progress: Some(1.0),
            },
        );

        Ok(SaveWriteResult {
            archive_bytes,
            tables_written: snapshot.datasets.len(),
            rows_written: total_rows,
        })
    }

    fn write_temp_archive(
        &self,
        snapshot: &SaveSnapshot,
        manifest: &ProjectManifest,
        graph_docs: &[GraphDoc],
        temp_path: &Path,
        total_rows: usize,
        progress_cb: Option<&SaveProgressCallback<'_>>,
    ) -> Result<(), AppError> {
        let temp_file = std::fs::File::create(temp_path)?;
        let mut zip = zip::ZipWriter::new(temp_file);
        let file_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let dir_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        let manifest_bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::FileIO(format!("failed to serialize manifest: {e}")))?;
        zip.start_file("manifest.json", file_opts)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        zip.write_all(&manifest_bytes)?;

        for folder in &manifest.folders {
            zip.add_directory(format!("{folder}/"), dir_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        let graph_by_id: HashMap<&str, &GraphDoc> =
            graph_docs.iter().map(|doc| (doc.id.as_str(), doc)).collect();
        let mut rows_written = 0usize;

        for (table_index, dataset) in snapshot.datasets.iter().enumerate() {
            emit_progress(
                progress_cb,
                SaveProgress {
                    phase: SavePhase::Table,
                    table_index,
                    table_total: snapshot.datasets.len(),
                    table_name: Some(dataset.name.clone()),
                    rows_done: rows_written,
                    rows_total: total_rows,
                    overall_progress: Some(progress_fraction(rows_written, total_rows)),
                },
            );

            let Some(table_ref) = manifest.tables.iter().find(|entry| entry.id == dataset.id) else {
                return Err(AppError::FileIO(format!(
                    "missing manifest table reference for dataset {}",
                    dataset.id
                )));
            };

            let plan = {
                let db = self
                    .state
                    .db
                    .lock()
                    .map_err(|e| AppError::Database(e.to_string()))?;
                db.prepare_archive_keyset_read(&dataset.id)?
            };

            let columns = table_columns_from_plan(
                &dataset.id,
                &plan,
                &snapshot.column_display,
            );

            zip.start_file(&table_ref.file, file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_table_header(&mut zip, dataset, &columns)?;
            run_test_hook(
                SaveFailurePoint::AfterHeader,
                SaveHookContext {
                    dataset_id: Some(dataset.id.clone()),
                    retained_batch_bytes: None,
                },
            )?;

            let mut next_row_id = 0i64;
            let mut first_row = true;
            let dataset_rows_total = usize::try_from(dataset.row_count.max(0)).unwrap_or(usize::MAX);
            let mut dataset_rows_done = 0usize;
            let mut throttle = RowProgressThrottle::default();

            loop {
                let batch = {
                    let db = self
                        .state
                        .db
                        .lock()
                        .map_err(|e| AppError::Database(e.to_string()))?;
                    db.read_archive_keyset_batch(
                        &plan,
                        next_row_id,
                        ROW_LIMIT_PER_BATCH,
                        TARGET_BATCH_BYTES,
                        HARD_BATCH_BYTES,
                    )?
                };

                if batch.rows.is_empty() {
                    break;
                }

                run_test_hook(
                    SaveFailurePoint::BetweenBatches,
                    SaveHookContext {
                        dataset_id: Some(dataset.id.clone()),
                        retained_batch_bytes: Some(batch.retained_bytes_estimate),
                    },
                )?;

                for row in batch.rows {
                    if !first_row {
                        zip.write_all(b",")?;
                    }
                    first_row = false;

                    write_streamed_row(&mut zip, row.row_id, &row.values, &plan)?;
                    next_row_id = row.row_id;

                    dataset_rows_done = dataset_rows_done.saturating_add(1);
                    rows_written = rows_written.saturating_add(1);

                    let force = dataset_rows_done == dataset_rows_total;
                    let now_ms = self.clock.now_ms();
                    if throttle.should_emit(now_ms, force) {
                        emit_progress(
                            progress_cb,
                            SaveProgress {
                                phase: SavePhase::Table,
                                table_index,
                                table_total: snapshot.datasets.len(),
                                table_name: Some(dataset.name.clone()),
                                rows_done: rows_written,
                                rows_total: total_rows,
                                overall_progress: Some(progress_fraction(rows_written, total_rows)),
                            },
                        );
                    }
                }
            }

            zip.write_all(b"]}")?;
        }

        emit_progress(
            progress_cb,
            SaveProgress {
                phase: SavePhase::Metadata,
                table_index: snapshot.datasets.len(),
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: rows_written,
                rows_total: total_rows,
                overall_progress: Some(progress_fraction(rows_written, total_rows)),
            },
        );

        for graph_ref in &manifest.graphs {
            if let Some(graph_doc) = graph_by_id.get(graph_ref.id.as_str()) {
                zip.start_file(&graph_ref.file, file_opts)
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
                let bytes = serde_json::to_vec(graph_doc)
                    .map_err(|e| AppError::FileIO(format!("failed to serialize graph doc: {e}")))?;
                zip.write_all(&bytes)?;
            }
        }

        if !snapshot.request.history.is_empty() {
            zip.start_file(".history.json", file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            serde_json::to_writer(&mut zip, &snapshot.request.history)
                .map_err(|e| AppError::FileIO(format!("failed to serialize history: {e}")))?;
        }
        if !snapshot.request.snapshots.is_empty() {
            zip.start_file(".snapshots.json", file_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            serde_json::to_writer(&mut zip, &snapshot.request.snapshots)
                .map_err(|e| AppError::FileIO(format!("failed to serialize snapshots: {e}")))?;
        }

        emit_progress(
            progress_cb,
            SaveProgress {
                phase: SavePhase::Compressing,
                table_index: snapshot.datasets.len(),
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: rows_written,
                rows_total: total_rows,
                overall_progress: Some(progress_fraction(rows_written, total_rows)),
            },
        );

        run_test_hook(
            SaveFailurePoint::ZipFinish,
            SaveHookContext {
                dataset_id: None,
                retained_batch_bytes: None,
            },
        )?;
        let finished_file = zip
            .finish()
            .map_err(|e| AppError::FileIO(format!("failed to finish archive: {e}")))?;

        run_test_hook(
            SaveFailurePoint::SyncAll,
            SaveHookContext {
                dataset_id: None,
                retained_batch_bytes: None,
            },
        )?;
        finished_file.sync_all()?;

        emit_progress(
            progress_cb,
            SaveProgress {
                phase: SavePhase::Finalizing,
                table_index: snapshot.datasets.len(),
                table_total: snapshot.datasets.len(),
                table_name: None,
                rows_done: rows_written,
                rows_total: total_rows,
                overall_progress: None,
            },
        );

        run_test_hook(
            SaveFailurePoint::Validation,
            SaveHookContext {
                dataset_id: None,
                retained_batch_bytes: None,
            },
        )?;

        let mut expected_entries = Vec::new();
        if !snapshot.request.history.is_empty() {
            expected_entries.push(".history.json");
        }
        if !snapshot.request.snapshots.is_empty() {
            expected_entries.push(".snapshots.json");
        }
        spprj_archive::validate_archive_manifest_and_entries(temp_path, manifest, &expected_entries)?;

        Ok(())
    }
}

fn validate_destination_path(destination_path: &Path) -> Result<(), AppError> {
    let parent = destination_path.parent().ok_or_else(|| {
        AppError::InvalidParam("destination path must have a parent directory".to_string())
    })?;
    if !parent.exists() {
        return Err(AppError::InvalidParam(format!(
            "destination parent does not exist: {}",
            parent.to_string_lossy()
        )));
    }
    Ok(())
}

fn table_columns_from_plan(
    dataset_id: &str,
    plan: &ArchiveKeysetReadPlan,
    column_display: &HashMap<String, Vec<ColumnDisplayProps>>,
) -> Vec<TableColumn> {
    let display = column_display.get(dataset_id);
    plan.columns
        .iter()
        .enumerate()
        .map(|(index, (name, column_type))| {
            let props = display.and_then(|items| items.iter().find(|item| item.col_index == index));
            TableColumn {
                name: name.clone(),
                col_type: column_type.clone(),
                width: props.and_then(|item| item.width),
                format: props.and_then(|item| {
                    item.format.as_ref().map(|format| TableColumnFormat {
                        kind: format.kind.clone(),
                        decimals: format.decimals,
                        currency: format.currency.clone(),
                    })
                }),
                extras: props.and_then(|item| item.extras.clone()),
            }
        })
        .collect()
}

fn write_table_header<W: Write>(
    writer: &mut W,
    dataset: &crate::models::table::DatasetMeta,
    columns: &[TableColumn],
) -> Result<(), AppError> {
    writer.write_all(b"{\"id\":")?;
    serde_json::to_writer(&mut *writer, &dataset.id)
        .map_err(|e| AppError::FileIO(format!("failed to write table id: {e}")))?;
    writer.write_all(b",\"name\":")?;
    serde_json::to_writer(&mut *writer, &dataset.name)
        .map_err(|e| AppError::FileIO(format!("failed to write table name: {e}")))?;
    writer.write_all(b",\"sourceType\":")?;
    serde_json::to_writer(&mut *writer, &dataset.source_type)
        .map_err(|e| AppError::FileIO(format!("failed to write table source type: {e}")))?;
    writer.write_all(b",\"version\":")?;
    serde_json::to_writer(&mut *writer, TABLE_DOC_VERSION)
        .map_err(|e| AppError::FileIO(format!("failed to write table version: {e}")))?;
    writer.write_all(b",\"columns\":")?;
    serde_json::to_writer(&mut *writer, columns)
        .map_err(|e| AppError::FileIO(format!("failed to write columns: {e}")))?;
    writer.write_all(b",\"rows\":[")?;
    Ok(())
}

fn write_streamed_row<W: Write>(
    writer: &mut W,
    row_id: i64,
    values: &[duckdb::types::Value],
    plan: &ArchiveKeysetReadPlan,
) -> Result<(), AppError> {
    writer.write_all(b"[")?;
    write_archive_cell(writer, &duckdb::types::Value::BigInt(row_id), "BIGINT")?;
    for (index, value) in values.iter().enumerate() {
        writer.write_all(b",")?;
        write_archive_cell(writer, value, &plan.columns[index].1)?;
    }
    writer.write_all(b"]")?;
    Ok(())
}

fn emit_progress(progress_cb: Option<&SaveProgressCallback<'_>>, progress: SaveProgress) {
    if let Some(callback) = progress_cb {
        callback(progress);
    }
}

fn progress_fraction(rows_done: usize, rows_total: usize) -> f64 {
    if rows_total == 0 {
        1.0
    } else {
        (rows_done as f64 / rows_total as f64).clamp(0.0, 1.0)
    }
}

fn replace_archive_atomically_os(temp_path: &Path, destination_path: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        return replace_existing_windows(temp_path, destination_path);
    }

    #[cfg(not(windows))]
    {
        // POSIX rename within the same directory is atomic and overwrites the
        // destination if it exists.
        std::fs::rename(temp_path, destination_path)?;
        Ok(())
    }
}

#[cfg(windows)]
fn replace_existing_windows(temp_path: &Path, destination_path: &Path) -> Result<(), AppError> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PATH_NOT_FOUND: i32 = 3;
    const ERROR_NOT_FOUND: i32 = 1168;

    extern "system" {
        fn ReplaceFileW(
            lp_replaced_file_name: *const u16,
            lp_replacement_file_name: *const u16,
            lp_backup_file_name: *const u16,
            dw_replace_flags: u32,
            lp_exclude: *mut c_void,
            lp_reserved: *mut c_void,
        ) -> i32;
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    let dest_wide = destination_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let temp_wide = temp_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();

    let replaced = unsafe {
        ReplaceFileW(
            dest_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        let replace_error = std::io::Error::last_os_error();
        let code = replace_error.raw_os_error().unwrap_or_default();
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND || code == ERROR_NOT_FOUND {
            let moved = unsafe {
                MoveFileExW(
                    temp_wide.as_ptr(),
                    dest_wide.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if moved == 0 {
                return Err(AppError::FileIO(std::io::Error::last_os_error().to_string()));
            }
            return Ok(());
        }
        return Err(AppError::FileIO(replace_error.to_string()));
    }

    Ok(())
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SaveFailurePoint {
    AfterHeader,
    BetweenBatches,
    ZipFinish,
    SyncAll,
    Validation,
}

#[cfg(test)]
#[derive(Clone)]
struct SaveHookContext {
    dataset_id: Option<String>,
    retained_batch_bytes: Option<usize>,
}

#[cfg(test)]
type SaveTestHook = Box<dyn FnMut(SaveFailurePoint, SaveHookContext) -> Result<(), AppError>>;

#[cfg(test)]
thread_local! {
    static SAVE_TEST_HOOK: std::cell::RefCell<Option<SaveTestHook>> = std::cell::RefCell::new(None);
}

#[cfg(test)]
fn install_save_test_hook(hook: Option<SaveTestHook>) {
    SAVE_TEST_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
fn run_test_hook(point: SaveFailurePoint, context: SaveHookContext) -> Result<(), AppError> {
    SAVE_TEST_HOOK.with(|slot| {
        let mut hook_slot = slot.borrow_mut();
        if let Some(hook) = hook_slot.as_mut() {
            hook(point, context)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
#[derive(Clone)]
struct SaveHookContext {
    dataset_id: Option<String>,
    retained_batch_bytes: Option<usize>,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SaveFailurePoint {
    AfterHeader,
    BetweenBatches,
    ZipFinish,
    SyncAll,
    Validation,
}

#[cfg(not(test))]
fn run_test_hook(_point: SaveFailurePoint, context: SaveHookContext) -> Result<(), AppError> {
    let _ = context.dataset_id;
    let _ = context.retained_batch_bytes;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use duckdb::params;

    use crate::error::AppError;
    use crate::models::project::ProjectInfo;
    use crate::models::save::{SavePhase, SaveProjectRequest, SaveSnapshot};
    use crate::services::spprj_archive;
    use crate::state::AppState;

    use super::{
        install_save_test_hook, ArchiveReplacer, SaveClock, SaveFailurePoint,
        StreamingProjectWriter,
        HARD_BATCH_BYTES,
    };

    #[derive(Default)]
    struct TestReplacerState {
        calls: AtomicUsize,
        fail: AtomicUsize,
    }

    struct TestReplacer {
        state: Arc<TestReplacerState>,
    }

    impl ArchiveReplacer for TestReplacer {
        fn replace_archive(&self, temp_path: &std::path::Path, destination_path: &std::path::Path) -> Result<(), AppError> {
            self.state.calls.fetch_add(1, Ordering::SeqCst);
            if self.state.fail.load(Ordering::SeqCst) != 0 {
                return Err(AppError::FileIO("simulated replacement failure".to_string()));
            }
            place_temp_for_test(temp_path, destination_path)?;
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum ReplacementRaceMode {
        DestinationAppears,
        DestinationDisappears,
    }

    struct RaceReplacer {
        mode: ReplacementRaceMode,
        calls: AtomicUsize,
    }

    impl ArchiveReplacer for RaceReplacer {
        fn replace_archive(&self, temp_path: &std::path::Path, destination_path: &std::path::Path) -> Result<(), AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.mode {
                ReplacementRaceMode::DestinationAppears => {
                    if !destination_path.exists() {
                        std::fs::write(destination_path, b"appeared-during-race")?;
                    }
                }
                ReplacementRaceMode::DestinationDisappears => {
                    if destination_path.exists() {
                        std::fs::remove_file(destination_path)?;
                    }
                }
            }
            place_temp_for_test(temp_path, destination_path)?;
            Ok(())
        }
    }

    fn place_temp_for_test(temp_path: &std::path::Path, destination_path: &std::path::Path) -> Result<(), AppError> {
        // Test seam: model "replace existing" behavior without deleting the
        // destination first. This is intentionally not an atomic guarantee.
        if destination_path.exists() {
            let bytes = std::fs::read(temp_path)?;
            std::fs::write(destination_path, bytes)?;
            std::fs::remove_file(temp_path)?;
            Ok(())
        } else {
            std::fs::rename(temp_path, destination_path)?;
            Ok(())
        }
    }

    struct StepClock {
        now: AtomicU64,
        step_ms: u64,
    }

    impl StepClock {
        fn new(step_ms: u64) -> Self {
            Self {
                now: AtomicU64::new(0),
                step_ms,
            }
        }

        fn current(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
    }

    impl SaveClock for StepClock {
        fn now_ms(&self) -> u64 {
            self.now.fetch_add(self.step_ms, Ordering::SeqCst)
        }
    }

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "stats_playground_streaming_{label}_{}.spprj",
            uuid::Uuid::new_v4()
        ))
    }

    fn seed_benchmark_dataset(state: &AppState, rows: usize) -> crate::models::table::DatasetMeta {
        let db = state.db.lock().unwrap();
        db.seed_benchmark_table("stream-ds", "Stream DS", rows, 4)
            .unwrap();
        db.get_dataset_meta("stream-ds").unwrap()
    }

    fn seed_gapped_dataset(state: &AppState) -> crate::models::table::DatasetMeta {
        let db = state.db.lock().unwrap();
        db.create_empty_table(
            "gapped",
            "Gapped",
            &["value".to_string()],
            &["BIGINT".to_string()],
        )
            .unwrap();

        for row_id in [1_i64, 2, 8, 1001] {
            db.conn()
                .execute(
                    "INSERT INTO \"dataset_gapped\" (\"_row_id\", \"value\") VALUES ($1, $2)",
                    params![row_id, row_id * 10],
                )
                .unwrap();
        }
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET row_count = 4 WHERE id = 'gapped'",
                [],
            )
            .unwrap();
        db.get_dataset_meta("gapped").unwrap()
    }

    fn save_snapshot(
        destination_path: &std::path::Path,
        datasets: Vec<crate::models::table::DatasetMeta>,
    ) -> SaveSnapshot {
        SaveSnapshot {
            current_project: ProjectInfo {
                name: "Streaming Project".to_string(),
                file_path: destination_path.to_string_lossy().to_string(),
                created_at: "2026-08-21T00:00:00Z".to_string(),
            },
            destination_path: destination_path.to_path_buf(),
            destination_name: "Streaming Project".to_string(),
            datasets,
            column_display: HashMap::new(),
            request: SaveProjectRequest {
                file_path: None,
                history: vec![serde_json::json!({"event": "save"})],
                snapshots: vec![serde_json::json!({"id": "snap-1"})],
                graph_builders: vec![serde_json::json!({
                    "id": "graph-1",
                    "name": "Graph 1",
                    "graphType": "line",
                })],
                tabulates: vec![serde_json::json!({"id": "tab-1"})],
                folders: vec!["Bench".to_string(), "Bench/Sub".to_string()],
                table_folders: HashMap::new(),
                graph_folders: HashMap::new(),
                tabulate_folders: HashMap::new(),
            },
        }
    }

    #[test]
    fn stream_writer_scales_and_keeps_batch_memory_bounded() {
        for row_count in [0usize, 1, 10, 5_000, 300_000] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, row_count);
            let destination = temp_path("scale");
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let max_batch_bytes = Arc::new(AtomicUsize::new(0));
            let max_batch_clone = Arc::clone(&max_batch_bytes);
            install_save_test_hook(Some(Box::new(move |point, context| {
                if point == SaveFailurePoint::BetweenBatches {
                    if let Some(bytes) = context.retained_batch_bytes {
                        let mut current = max_batch_clone.load(Ordering::SeqCst);
                        while bytes > current {
                            match max_batch_clone.compare_exchange(
                                current,
                                bytes,
                                Ordering::SeqCst,
                                Ordering::SeqCst,
                            ) {
                                Ok(_) => break,
                                Err(next) => current = next,
                            }
                        }
                    }
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            let result = writer
                .write(&snapshot, &destination, None)
                .expect("streaming save should succeed");
            install_save_test_hook(None);

            assert_eq!(result.tables_written, 1);
            assert_eq!(result.rows_written, row_count);
            assert!(result.archive_bytes > 0);
            assert!(max_batch_bytes.load(Ordering::SeqCst) < HARD_BATCH_BYTES);

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), row_count);
            if row_count > 0 {
                assert_eq!(reopened.tables[0].rows[0][0], serde_json::json!(1));
                assert_eq!(
                    reopened.tables[0].rows[row_count - 1][0],
                    serde_json::json!(row_count as i64)
                );
            }

            let _ = std::fs::remove_file(destination);
        }
    }

    #[test]
    fn stream_writer_preserves_gapped_row_ids_and_order() {
        let state = AppState::new().unwrap();
        let dataset = seed_gapped_dataset(&state);
        let destination = temp_path("gapped");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        writer.write(&snapshot, &destination, None).unwrap();

        let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
        assert_eq!(reopened.tables.len(), 1);
        let ids = reopened.tables[0]
            .rows
            .iter()
            .map(|row| row[0].as_i64().unwrap())
            .collect::<Vec<_>>();
        let values = reopened.tables[0]
            .rows
            .iter()
            .map(|row| row[1].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![1, 2, 8, 1001]);
        assert_eq!(values, vec![10, 20, 80, 10010]);

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_allows_read_interleaving_between_batches() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_empty_table(
                "interleave",
                "Interleave",
                &["payload".to_string()],
                &["VARCHAR".to_string()],
            )
                .unwrap();
            let payload = "x".repeat(220_000);
            for row_id in 1..=60_i64 {
                db.conn()
                    .execute(
                        "INSERT INTO \"dataset_interleave\" (\"_row_id\", \"payload\") VALUES ($1, $2)",
                        params![row_id, payload.as_str()],
                    )
                    .unwrap();
            }
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 60 WHERE id = 'interleave'",
                    [],
                )
                .unwrap();
        }

        let dataset = {
            let db = state.db.lock().unwrap();
            db.get_dataset_meta("interleave").unwrap()
        };
        let destination = temp_path("interleave");
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let hook_seen = Arc::new(AtomicUsize::new(0));
        thread::scope(|scope| {
            let (reader_start_tx, reader_start_rx) = mpsc::channel::<()>();
            let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
            let state_ref = &state;

            let reader = scope.spawn(move || {
                reader_start_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("reader did not receive start signal");
                let db = state_ref.db.lock().unwrap();
                let listed = db.list_datasets().unwrap();
                assert!(!listed.is_empty());
                drop(db);
                reader_done_tx
                    .send(())
                    .expect("reader completion signal failed");
            });

            let hook_seen_clone = Arc::clone(&hook_seen);
            install_save_test_hook(Some(Box::new(move |point, _| {
                if point == SaveFailurePoint::BetweenBatches {
                    let seen = hook_seen_clone.fetch_add(1, Ordering::SeqCst);
                    if seen == 0 {
                        reader_start_tx
                            .send(())
                            .map_err(|e| AppError::FileIO(format!("failed to start reader: {e}")))?;
                        if reader_done_rx.recv_timeout(Duration::from_secs(5)).is_err() {
                            return Err(AppError::FileIO(
                                "reader did not complete while writer paused between batches"
                                    .to_string(),
                            ));
                        }
                    }
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            writer.write(&snapshot, &destination, None).unwrap();
            install_save_test_hook(None);
            reader.join().unwrap();
        });

        assert!(hook_seen.load(Ordering::SeqCst) >= 1);

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_is_throttled_without_sleep() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 300);
        let destination = temp_path("progress");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let clock = Arc::new(StepClock::new(50));

        let progress_events: Arc<Mutex<Vec<(u64, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);
        let clock_for_cb = Arc::clone(&clock);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock(&state, &guard, clock);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((clock_for_cb.current(), event));
                }),
            )
            .unwrap();

        let events = progress_events.lock().unwrap();
        let table_events = events
            .iter()
            .filter(|(_, event)| event.phase == SavePhase::Table)
            .cloned()
            .collect::<Vec<_>>();

        assert!(table_events.len() >= 3);
        let advancing_events = table_events
            .into_iter()
            .filter(|(_, event)| event.rows_done > 0 && event.rows_done < event.rows_total)
            .collect::<Vec<_>>();
        assert!(advancing_events.len() >= 2);

        for pair in advancing_events.windows(2) {
            let delta = pair[1].0.saturating_sub(pair[0].0);
            assert!(delta >= 100);
            assert!(delta <= 250);
        }

        let phases = events
            .iter()
            .map(|(_, event)| event.phase)
            .collect::<Vec<_>>();
        assert!(phases.contains(&SavePhase::Preparing));
        assert!(phases.contains(&SavePhase::Table));
        assert!(phases.contains(&SavePhase::Metadata));
        assert!(phases.contains(&SavePhase::Compressing));
        assert!(phases.contains(&SavePhase::Finalizing));

        let preparing_idx = phases.iter().position(|phase| *phase == SavePhase::Preparing).unwrap();
        let first_table_idx = phases.iter().position(|phase| *phase == SavePhase::Table).unwrap();
        let metadata_idx = phases.iter().position(|phase| *phase == SavePhase::Metadata).unwrap();
        let compressing_idx = phases.iter().position(|phase| *phase == SavePhase::Compressing).unwrap();
        let finalizing_idx = phases.iter().rposition(|phase| *phase == SavePhase::Finalizing).unwrap();
        assert!(preparing_idx < first_table_idx);
        assert!(first_table_idx < metadata_idx);
        assert!(metadata_idx < compressing_idx);
        assert!(compressing_idx < finalizing_idx);

        let mut last_progress = 0.0_f64;
        for (_, event) in events.iter() {
            if let Some(progress) = event.overall_progress {
                assert!(progress >= last_progress);
                last_progress = progress;
            }
        }

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_handles_zero_rows_and_large_time_jumps() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 0);
        let destination = temp_path("progress-zero");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let clock = Arc::new(StepClock::new(300));

        let progress_events: Arc<Mutex<Vec<(u64, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);
        let clock_for_cb = Arc::clone(&clock);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock(&state, &guard, clock);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((clock_for_cb.current(), event));
                }),
            )
            .unwrap();

        let events = progress_events.lock().unwrap();
        let preparing = events
            .iter()
            .find(|(_, event)| event.phase == SavePhase::Preparing)
            .expect("preparing event should be emitted");
        assert_eq!(preparing.1.rows_total, 0);
        assert_eq!(preparing.1.overall_progress, Some(0.0));

        let finalizing = events
            .iter()
            .rfind(|(_, event)| event.phase == SavePhase::Finalizing)
            .expect("finalizing event should be emitted");
        assert_eq!(finalizing.1.rows_done, 0);
        assert_eq!(finalizing.1.rows_total, 0);
        assert_eq!(finalizing.1.overall_progress, Some(1.0));

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_emits_on_advancement_checkpoints_after_large_jumps() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 80);
        let destination = temp_path("progress-jumps");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let clock = Arc::new(StepClock::new(120));

        let progress_events: Arc<Mutex<Vec<(u64, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);
        let clock_for_cb = Arc::clone(&clock);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock(&state, &guard, clock);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((clock_for_cb.current(), event));
                }),
            )
            .unwrap();

        let events = progress_events.lock().unwrap();
        let advancing_events = events
            .iter()
            .filter(|(_, event)| {
                event.phase == SavePhase::Table
                    && event.rows_done > 0
                    && event.rows_done < event.rows_total
            })
            .cloned()
            .collect::<Vec<_>>();
        assert!(advancing_events.len() >= 2);

        for pair in advancing_events.windows(2) {
            let delta = pair[1].0.saturating_sub(pair[0].0);
            assert!(delta >= 100);
            assert!(delta <= 250);
        }

        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn stream_writer_progress_first_advancing_event_waits_for_minimum_interval() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 40);
        let destination = temp_path("progress-first-window");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let clock = Arc::new(StepClock::new(60));

        let progress_events: Arc<Mutex<Vec<(u64, crate::models::save::SaveProgress)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let progress_events_clone = Arc::clone(&progress_events);
        let clock_for_cb = Arc::clone(&clock);

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock(&state, &guard, clock);
        writer
            .write(
                &snapshot,
                &destination,
                Some(&|event| {
                    progress_events_clone
                        .lock()
                        .unwrap()
                        .push((clock_for_cb.current(), event));
                }),
            )
            .unwrap();

        let events = progress_events.lock().unwrap();
        let first_advancing = events
            .iter()
            .find(|(_, event)| {
                event.phase == SavePhase::Table
                    && event.rows_done > 0
                    && event.rows_done < event.rows_total
            })
            .expect("expected an advancing progress event");

        assert!(first_advancing.0 >= 100);
        assert!(first_advancing.0 <= 250);

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_failure_injection_preserves_destination_and_avoids_completion() {
        for point in [
            SaveFailurePoint::AfterHeader,
            SaveFailurePoint::BetweenBatches,
            SaveFailurePoint::ZipFinish,
            SaveFailurePoint::SyncAll,
            SaveFailurePoint::Validation,
        ] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 64);
            let destination = temp_path("failure");
            std::fs::write(&destination, b"original-bytes").unwrap();
            let original = std::fs::read(&destination).unwrap();

            let snapshot = save_snapshot(&destination, vec![dataset]);
            let progress_events: Arc<Mutex<Vec<crate::models::save::SaveProgress>>> =
                Arc::new(Mutex::new(Vec::new()));
            let progress_events_clone = Arc::clone(&progress_events);

            install_save_test_hook(Some(Box::new(move |hook_point, _| {
                if hook_point == point {
                    return Err(AppError::FileIO(format!("injected failure at {hook_point:?}")));
                }
                Ok(())
            })));

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::new(&state, &guard);
            let error = writer
                .write(
                    &snapshot,
                    &destination,
                    Some(&|event| {
                        progress_events_clone.lock().unwrap().push(event);
                    }),
                )
                .unwrap_err();
            install_save_test_hook(None);

            assert!(matches!(error, AppError::FileIO(_)));
            let after = std::fs::read(&destination).unwrap();
            assert_eq!(after, original);
            assert!(!PathBuf::from(format!("{}.tmp", destination.to_string_lossy())).exists());

            let progress = progress_events.lock().unwrap();
            let has_completion = progress.iter().any(|event| {
                event.phase == SavePhase::Finalizing && event.overall_progress == Some(1.0)
            });
            assert!(!has_completion);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_replacement_failure_preserves_destination_bytes_and_cleans_temp() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 64);
        let destination = temp_path("replace-failure");
        std::fs::write(&destination, b"original-bytes").unwrap();
        let original = std::fs::read(&destination).unwrap();
        let snapshot = save_snapshot(&destination, vec![dataset]);

        let replacer_state = Arc::new(TestReplacerState::default());
        replacer_state.fail.store(1, Ordering::SeqCst);
        let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TestReplacer {
            state: Arc::clone(&replacer_state),
        });
        let clock = Arc::new(StepClock::new(50));

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::with_clock_and_replacer(&state, &guard, clock, replacer);
        let error = writer.write(&snapshot, &destination, None).unwrap_err();

        assert!(matches!(error, AppError::FileIO(_)));
        assert_eq!(replacer_state.calls.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(&destination).unwrap(), original);
        assert!(!PathBuf::from(format!("{}.tmp", destination.to_string_lossy())).exists());

        let _ = std::fs::remove_file(&destination);
    }

    #[test]
    fn stream_writer_replacer_replaces_present_and_absent_destinations() {
        for had_destination in [false, true] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 32);
            let destination = temp_path("replace-present-absent");
            if had_destination {
                std::fs::write(&destination, b"previous-bytes").unwrap();
            }
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let replacer_state = Arc::new(TestReplacerState::default());
            let replacer: Arc<dyn ArchiveReplacer> = Arc::new(TestReplacer {
                state: Arc::clone(&replacer_state),
            });

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::with_clock_and_replacer(
                &state,
                &guard,
                Arc::new(StepClock::new(50)),
                replacer,
            );
            writer.write(&snapshot, &destination, None).unwrap();

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), 32);
            assert_eq!(replacer_state.calls.load(Ordering::SeqCst), 1);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_replacer_handles_destination_appearance_and_disappearance_races() {
        for (mode, preseed_destination) in [
            (ReplacementRaceMode::DestinationAppears, false),
            (ReplacementRaceMode::DestinationDisappears, true),
        ] {
            let state = AppState::new().unwrap();
            let dataset = seed_benchmark_dataset(&state, 16);
            let destination = temp_path("replace-race");
            if preseed_destination {
                std::fs::write(&destination, b"existing-before-race").unwrap();
            }
            let snapshot = save_snapshot(&destination, vec![dataset]);

            let race_replacer = Arc::new(RaceReplacer {
                mode,
                calls: AtomicUsize::new(0),
            });

            let guard = state.save_coordinator.begin_save().unwrap();
            let writer = StreamingProjectWriter::with_clock_and_replacer(
                &state,
                &guard,
                Arc::new(StepClock::new(50)),
                race_replacer.clone(),
            );
            writer.write(&snapshot, &destination, None).unwrap();

            let reopened = spprj_archive::read_project_file(destination.to_str().unwrap()).unwrap();
            assert_eq!(reopened.tables.len(), 1);
            assert_eq!(reopened.tables[0].rows.len(), 16);
            assert_eq!(race_replacer.calls.load(Ordering::SeqCst), 1);

            let _ = std::fs::remove_file(&destination);
        }
    }

    #[test]
    fn stream_writer_rejects_destination_path_mismatch() {
        let state = AppState::new().unwrap();
        let dataset = seed_benchmark_dataset(&state, 1);
        let destination = temp_path("path-match");
        let snapshot = save_snapshot(&destination, vec![dataset]);
        let mismatch = temp_path("path-mismatch");

        let guard = state.save_coordinator.begin_save().unwrap();
        let writer = StreamingProjectWriter::new(&state, &guard);
        let error = writer.write(&snapshot, &mismatch, None).unwrap_err();
        assert!(matches!(error, AppError::InvalidParam(_)));

        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(&mismatch);
    }
}
