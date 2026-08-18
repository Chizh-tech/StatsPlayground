use crate::error::AppError;
use crate::models::table::DatasetMeta;
use crate::state::AppState;
use std::collections::HashMap;

pub struct IoService<'a> {
    state: &'a AppState,
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
        let results = db.import_sqlite(file_path, &on_progress)?;
        Ok(results.into_iter().map(|(_, meta)| meta).collect())
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
