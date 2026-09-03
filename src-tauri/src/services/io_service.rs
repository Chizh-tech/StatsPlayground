use crate::error::AppError;
use crate::models::data_link::{ImportSummary, ImportTableSummary, SqliteImportSelection};
use crate::models::table::DatasetMeta;
use crate::state::AppState;
use std::collections::HashMap;

pub struct IoService<'a> {
    state: &'a AppState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_only_sqlite_import_does_not_trigger_legacy_import_all() {
        let path = std::env::temp_dir().join(format!(
            "datalink-skip-only-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let sqlite = rusqlite::Connection::open(&path).expect("create SQLite fixture");
        sqlite
            .execute_batch("CREATE TABLE existing_values (id INTEGER); INSERT INTO existing_values VALUES (1);")
            .expect("populate SQLite fixture");
        drop(sqlite);

        let state = AppState::new().expect("create app state");
        let summary = IoService::new(&state)
            .import_selected_sqlite(
                path.to_str().expect("fixture path"),
                &[SqliteImportSelection {
                    source_name: "existing_values".to_string(),
                    target_name: "existing_values".to_string(),
                    action: "skip".to_string(),
                }],
                |_, _, _, _, _| {},
                || false,
            )
            .expect("summarize skipped import");

        assert_eq!(summary.status, "completed");
        assert!(summary.imported.is_empty());
        assert_eq!(summary.skipped.len(), 1);
        assert_eq!(summary.total_rows_written, 0);
        assert!(state
            .db
            .lock()
            .expect("lock database")
            .list_datasets()
            .expect("list datasets")
            .is_empty());

        std::fs::remove_file(path).expect("remove fixture");
    }
}

impl<'a> IoService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_csv(dataset_id, output_path)
    }

    pub fn import_sqlite<F>(
        &self,
        file_path: &str,
        on_progress: F,
    ) -> Result<Vec<DatasetMeta>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let results = db.import_sqlite(file_path, &on_progress, &|| false)?;
        Ok(results.into_iter().map(|(_, meta, _)| meta).collect())
    }

    pub fn import_selected_sqlite<F, C>(
        &self,
        file_path: &str,
        selections: &[SqliteImportSelection],
        on_progress: F,
        is_cancelled: C,
    ) -> Result<ImportSummary, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
        C: Fn() -> bool,
    {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let skipped = selections
            .iter()
            .filter(|selection| selection.action == "skip")
            .map(|selection| ImportTableSummary {
                source_name: selection.source_name.clone(),
                target_name: selection.target_name.clone(),
                action: selection.action.clone(),
                rows_written: 0,
            })
            .collect::<Vec<_>>();
        let import_pairs = selections
            .iter()
            .filter(|selection| selection.action != "skip")
            .map(|selection| {
                (
                    selection.source_name.clone(),
                    selection.target_name.clone(),
                    selection.action == "append",
                )
            })
            .collect::<Vec<_>>();
        if import_pairs.is_empty() {
            return Ok(ImportSummary {
                status: "completed".to_string(),
                imported: Vec::new(),
                skipped,
                failed_table: None,
                error: None,
                total_rows_written: 0,
            });
        }
        let results =
            db.import_selected_sqlite(file_path, &import_pairs, &on_progress, &is_cancelled)?;
        let imported = results
            .into_iter()
            .zip(import_pairs)
            .map(
                |((source_name, _, rows_written), (_, target_name, append))| ImportTableSummary {
                    source_name,
                    target_name,
                    action: if append { "append" } else { "create" }.to_string(),
                    rows_written,
                },
            )
            .collect::<Vec<_>>();
        let total_rows_written = imported.iter().map(|table| table.rows_written).sum();
        Ok(ImportSummary {
            status: "completed".to_string(),
            imported,
            skipped,
            failed_table: None,
            error: None,
            total_rows_written,
        })
    }

    /// Export every dataset into a single SQLite database.
    pub fn export_sqlite(&self, output_path: &str) -> Result<(), AppError> {
        self.export_sqlite_subset(output_path, None, &HashMap::new())
    }

    /// Export a subset of datasets to a single SQLite database, with optional
    /// per-dataset name overrides (used by the UI to encode folder structure
    /// as `folder-table` table names).
    pub fn export_sqlite_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        name_overrides: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_sqlite_subset(output_path, subset, name_overrides)
    }

    /// Export every dataset as CSVs zipped together.
    pub fn export_csv_zip(&self, output_path: &str) -> Result<(), AppError> {
        self.export_csv_zip_subset(output_path, None, &HashMap::new())
    }

    /// Export a subset of datasets as CSVs zipped together, with optional
    /// per-dataset archive paths so the UI can preserve folder structure
    /// inside the zip.
    pub fn export_csv_zip_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        archive_paths: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        db.export_csv_zip_subset(output_path, subset, archive_paths)
    }
}
