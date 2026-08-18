use crate::error::AppError;
use crate::models::table::{DatasetMeta, SqlQueryResult, TableQueryResult};
use crate::state::AppState;

/// Compute the new index of a column originally at `idx` after a single column
/// is moved from `from` to `to`. Mirrors an array `remove(from) + insert(to)`.
fn remap_moved_index(idx: usize, from: usize, to: usize) -> usize {
    if idx == from {
        to
    } else if from < to {
        // Columns in (from, to] slide one slot left.
        if idx > from && idx <= to {
            idx - 1
        } else {
            idx
        }
    } else {
        // from > to: columns in [to, from) slide one slot right.
        if idx >= to && idx < from {
            idx + 1
        } else {
            idx
        }
    }
}

pub struct DataService<'a> {
    state: &'a AppState,
}

impl<'a> DataService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn import_csv(&self, file_path: &str) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled")
            .to_string();
        db.import_csv(&id, &name, file_path)
    }

    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.list_datasets()
    }

    pub fn delete_dataset(&self, dataset_id: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_dataset(dataset_id)
    }

    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.query_table(dataset_id, page, page_size, sort_by, sort_order)
    }

    pub fn execute_sql_query(
        &self,
        sql: &str,
        page: usize,
        page_size: usize,
    ) -> Result<SqlQueryResult, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.execute_sql_query(sql, page, page_size)
    }

    pub fn create_table(
        &self,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.create_empty_table(&id, name, column_names, column_types)
    }

    pub fn create_table_from_sql_query(&self, sql: &str, name: &str) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.create_table_from_sql_query(&id, name, sql)
    }

    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.add_row(dataset_id)
    }

    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.update_cell(dataset_id, row_id, column_name, value)
    }

    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_row(dataset_id, row_id)
    }

    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_dataset(dataset_id, new_name)
    }

    pub fn add_column(&self, dataset_id: &str, col_name: &str, col_type: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.add_column(dataset_id, col_name, col_type)
    }

    /// Insert a column at a specific visible index and shift any stored display
    /// props (width/format/extras) at/after that index one slot right so they
    /// stay aligned with the new column layout.
    pub fn insert_column_at(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: usize,
    ) -> Result<(), AppError> {
        {
            let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
            db.insert_column_at(dataset_id, col_name, col_type, at_index as i32)?;
        }
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if let Some(props) = display.get_mut(dataset_id) {
            for p in props.iter_mut() {
                if p.col_index >= at_index {
                    p.col_index += 1;
                }
            }
        }
        Ok(())
    }

    /// Move a column from visible index `from` to `to`, remapping stored display
    /// props so they follow their column to the new position.
    pub fn reorder_column(&self, dataset_id: &str, from: usize, to: usize) -> Result<(), AppError> {
        {
            let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
            db.reorder_column(dataset_id, from as i32, to as i32)?;
        }
        if from == to {
            return Ok(());
        }
        let mut display = self
            .state
            .column_display
            .lock()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if let Some(props) = display.get_mut(dataset_id) {
            for p in props.iter_mut() {
                p.col_index = remap_moved_index(p.col_index, from, to);
            }
        }
        Ok(())
    }

    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.delete_column(dataset_id, col_name)
    }

    pub fn rename_column(&self, dataset_id: &str, old_name: &str, new_name: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.rename_column(dataset_id, old_name, new_name)
    }

    pub fn change_column_type(&self, dataset_id: &str, col_name: &str, new_type: &str) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.change_column_type(dataset_id, col_name, new_type)
    }

    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        col_types: &[String],
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.paste_at_position(dataset_id, start_row, start_col, rows, header_names, col_types)
    }

    pub fn restore_snapshot(
        &self,
        dataset_id: &str,
        col_names: &[String],
        col_types: &[String],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.restore_snapshot(dataset_id, col_names, col_types, rows)
    }

    // ─── Table Operations ───

    pub fn get_columns(&self, dataset_id: &str) -> Result<Vec<(String, String)>, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.get_user_columns(dataset_id)
    }

    pub fn sort_table(
        &self, source_id: &str, sort_cols: &[String], sort_orders: &[String], new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.sort_table(&id, new_name, source_id, sort_cols, sort_orders)
    }

    pub fn subset_table(
        &self, source_id: &str, columns: &[String], row_filter: Option<&str>, new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.subset_table(&id, new_name, source_id, columns, row_filter)
    }

    pub fn transpose_table(&self, source_id: &str, new_name: &str) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.transpose_table(&id, new_name, source_id)
    }

    pub fn stack_table(
        &self, source_id: &str, stack_cols: &[String], id_cols: &[String], new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.stack_table(&id, new_name, source_id, stack_cols, id_cols)
    }

    pub fn split_table(
        &self, source_id: &str, split_col: &str, value_col: &str, id_cols: &[String], new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.split_table(&id, new_name, source_id, split_col, value_col, id_cols)
    }

    pub fn summary_table(
        &self, source_id: &str, stat_cols: &[String], group_cols: &[String], statistics: &[String], new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.summary_table(&id, new_name, source_id, stat_cols, group_cols, statistics)
    }

    pub fn join_tables(
        &self, left_id: &str, right_id: &str, join_type: &str, left_key: &str, right_key: &str, new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.join_tables(&id, new_name, left_id, right_id, join_type, left_key, right_key)
    }

    pub fn update_table(
        &self, left_id: &str, right_id: &str, match_col: &str, update_cols: &[String],
    ) -> Result<(), AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        db.update_table(left_id, right_id, match_col, update_cols)
    }

    pub fn concatenate_tables(
        &self, source_ids: &[String], new_name: &str,
    ) -> Result<DatasetMeta, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.concatenate_tables(&id, new_name, source_ids)
    }
}
