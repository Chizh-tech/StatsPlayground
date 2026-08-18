use duckdb::types::Value;
use duckdb::{params, params_from_iter, Connection};

use crate::error::AppError;
use crate::models::table::{DatasetMeta, TableQueryResult};
use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateResult, TabulateStatistic};

/// DuckDB engine wrapper
pub struct DuckDbEngine {
    conn: Connection,
}

type GroupedStatisticValues = std::collections::HashMap<(String, String), Vec<Option<f64>>>;

impl DuckDbEngine {
    /// Get a reference to the underlying connection
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Create a new in-memory DuckDB engine and initialize metadata tables
    pub fn new_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS _meta_datasets (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                source_path TEXT,
                source_type TEXT,
                row_count   BIGINT DEFAULT 0,
                col_count   INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR)),
                updated_at  TEXT DEFAULT (CAST(current_timestamp AS VARCHAR))
            );

            CREATE TABLE IF NOT EXISTS _meta_columns (
                dataset_id  TEXT,
                col_index   INTEGER,
                col_name    TEXT,
                col_type    TEXT,
                role        TEXT DEFAULT 'continuous',
                missing_count BIGINT DEFAULT 0,
                PRIMARY KEY (dataset_id, col_index)
            );
            ",
        )?;

        Ok(Self { conn })
    }

    pub fn tabulate(&self, request: &TabulateRequest) -> Result<TabulateResult, AppError> {
        let dataset_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_datasets WHERE id = $1",
            params![&request.dataset_id],
            |row| row.get(0),
        )?;
        if dataset_exists == 0 {
            return Err(AppError::InvalidParam(format!(
                "Unknown dataset: {}",
                request.dataset_id
            )));
        }

        validate_unique_fields("row", &request.row_fields)?;
        validate_unique_fields("column", &request.column_fields)?;

        let table_name = format!("dataset_{}", request.dataset_id.replace('-', "_"));
        let mut columns_stmt = self.conn.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        )?;
        let columns: Vec<(String, String)> = columns_stmt
            .query_map(params![&table_name], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if columns.is_empty() {
            return Err(AppError::InvalidParam(format!(
                "Unknown dataset: {}",
                request.dataset_id
            )));
        }

        let column_types: std::collections::HashMap<String, String> = columns.into_iter().collect();

        for field in request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
        {
            if !column_types.contains_key(field) {
                return Err(AppError::InvalidParam(format!("Unknown field: {field}",)));
            }
        }

        for statistic in &request.statistics {
            let data_type = column_types.get(&statistic.field).ok_or_else(|| {
                AppError::InvalidParam(format!("Unknown field: {}", statistic.field))
            })?;

            if requires_numeric_field(&statistic.kind) && !is_numeric_type(data_type) {
                return Err(AppError::InvalidParam(format!(
                    "Field '{}' must be numeric for {:?}",
                    statistic.field, statistic.kind
                )));
            }

            if matches!(statistic.kind, StatisticKind::Quantile) {
                let probability = statistic.quantile.ok_or_else(|| {
                    AppError::InvalidParam(format!(
                        "Quantile statistic '{}' requires quantile",
                        statistic.id
                    ))
                })?;
                if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
                    return Err(AppError::InvalidParam(
                        "quantile must be finite and in [0,1]".into(),
                    ));
                }
            }
        }

        let row_count = grouped_cardinality(&self.conn, &table_name, &request.row_fields)?;
        let column_count = grouped_cardinality(&self.conn, &table_name, &request.column_fields)?;
        let cell_count = row_count
            .checked_mul(column_count)
            .and_then(|value| value.checked_mul(request.statistics.len() as u64))
            .ok_or_else(|| AppError::InvalidParam("Tabulate result size overflow".into()))?;
        if cell_count > request.max_result_cells {
            return Err(AppError::InvalidParam(format!(
                "Tabulate result has {cell_count} cells; limit is {}",
                request.max_result_cells,
            )));
        }

        let row_members =
            self.query_dimension_members(&table_name, &request.row_fields, &column_types)?;
        let column_members =
            self.query_dimension_members(&table_name, &request.column_fields, &column_types)?;
        let grouped_values = self.query_grouped_values(
            &table_name,
            &request.row_fields,
            &request.column_fields,
            &request.statistics,
            &column_types,
        )?;
        let needs_row_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::RowPercentage));
        let needs_column_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::ColumnPercentage));
        let needs_total_denominators = request
            .statistics
            .iter()
            .any(|statistic| matches!(statistic.kind, StatisticKind::TotalPercentage));
        let needs_percentage_denominators =
            needs_row_denominators || needs_column_denominators || needs_total_denominators;

        let mut cells = Vec::with_capacity(cell_count as usize);
        for row_member in &row_members {
            let row_key = member_key(row_member)?;
            for column_member in &column_members {
                let column_key = member_key(column_member)?;
                if let Some(values) = grouped_values.get(&(row_key.clone(), column_key.clone())) {
                    cells.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        cells.push(default_missing_value(&statistic.kind));
                    }
                }
            }
        }

        let raw_row_totals = if request.include_row_totals || needs_row_denominators {
            let totals = self.query_grouped_values(
                &table_name,
                &request.row_fields,
                &[],
                &request.statistics,
                &column_types,
            )?;
            let empty_key = member_key(&[])?;
            let mut flattened = Vec::with_capacity(row_members.len() * request.statistics.len());
            for row_member in &row_members {
                let row_key = member_key(row_member)?;
                if let Some(values) = totals.get(&(row_key, empty_key.clone())) {
                    flattened.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        flattened.push(default_missing_value(&statistic.kind));
                    }
                }
            }
            flattened
        } else {
            Vec::new()
        };

        let raw_column_totals = if request.include_column_totals || needs_column_denominators {
            let totals = self.query_grouped_values(
                &table_name,
                &[],
                &request.column_fields,
                &request.statistics,
                &column_types,
            )?;
            let empty_key = member_key(&[])?;
            let mut flattened = Vec::with_capacity(column_members.len() * request.statistics.len());
            for column_member in &column_members {
                let column_key = member_key(column_member)?;
                if let Some(values) = totals.get(&(empty_key.clone(), column_key)) {
                    flattened.extend(values.iter().copied());
                } else {
                    for statistic in &request.statistics {
                        flattened.push(default_missing_value(&statistic.kind));
                    }
                }
            }
            flattened
        } else {
            Vec::new()
        };

        let raw_grand_totals = if request.include_row_totals
            || request.include_column_totals
            || needs_percentage_denominators
        {
            let totals = self.query_grouped_values(
                &table_name,
                &[],
                &[],
                &request.statistics,
                &column_types,
            )?;
            totals
                .get(&(member_key(&[])?, member_key(&[])?))
                .cloned()
                .unwrap_or_else(|| {
                    request
                        .statistics
                        .iter()
                        .map(|statistic| default_missing_value(&statistic.kind))
                        .collect()
                })
        } else {
            Vec::new()
        };

        let mut row_totals = if request.include_row_totals {
            raw_row_totals.clone()
        } else {
            Vec::new()
        };
        let mut column_totals = if request.include_column_totals {
            raw_column_totals.clone()
        } else {
            Vec::new()
        };
        let mut grand_totals = if request.include_row_totals || request.include_column_totals {
            raw_grand_totals.clone()
        } else {
            Vec::new()
        };

        if needs_percentage_denominators {
            let mut percentage_context = PercentageTransformContext {
                row_count: row_members.len(),
                column_count: column_members.len(),
                cells: &mut cells,
                row_totals: &mut row_totals,
                column_totals: &mut column_totals,
                grand_totals: &mut grand_totals,
                raw_row_totals: &raw_row_totals,
                raw_column_totals: &raw_column_totals,
                raw_grand_totals: &raw_grand_totals,
            };
            transform_percentage_values(&request.statistics, &mut percentage_context);
        }

        Ok(TabulateResult {
            row_members,
            column_members,
            statistics: request.statistics.clone(),
            cells,
            row_totals,
            column_totals,
            grand_totals,
            cell_count,
            limit: request.max_result_cells,
        })
    }

    fn query_dimension_members(
        &self,
        table_name: &str,
        dimensions: &[String],
        column_types: &std::collections::HashMap<String, String>,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        if dimensions.is_empty() {
            return Ok(vec![vec![]]);
        }

        let table_ident = quote_identifier(table_name);
        let select_dimensions = dimensions
            .iter()
            .enumerate()
            .map(|(index, field)| {
                dimension_select_expression(field, column_types)
                    .map(|expression| format!("{expression} AS \"__dim_{index}\""))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let group_dimensions = dimensions
            .iter()
            .map(|field| quote_identifier(field))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = build_nulls_last_order(dimensions);
        let sql = format!(
            "SELECT {select_dimensions} FROM {table_ident} GROUP BY {group_dimensions} ORDER BY {order_clause}"
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut members = Vec::new();
        while let Some(row) = rows.next()? {
            let mut values = Vec::with_capacity(dimensions.len());
            for index in 0..dimensions.len() {
                let value: Value = row.get(index)?;
                values.push(json_dimension_value(value));
            }
            members.push(values);
        }
        Ok(members)
    }

    fn query_grouped_values(
        &self,
        table_name: &str,
        row_fields: &[String],
        column_fields: &[String],
        statistics: &[TabulateStatistic],
        column_types: &std::collections::HashMap<String, String>,
    ) -> Result<GroupedStatisticValues, AppError> {
        let dimensions = row_fields
            .iter()
            .chain(column_fields.iter())
            .cloned()
            .collect::<Vec<_>>();
        let table_ident = quote_identifier(table_name);
        let statistic_sql = statistics
            .iter()
            .enumerate()
            .map(|(index, statistic)| {
                aggregate_sql(statistic).map(|sql| format!("{sql} AS \"__stat_{index}\""))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let sql = if dimensions.is_empty() {
            format!("SELECT {} FROM {}", statistic_sql.join(", "), table_ident)
        } else {
            let select_dimensions = dimensions
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    dimension_select_expression(field, column_types)
                        .map(|expression| format!("{expression} AS \"__dim_{index}\""))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            let group_dimensions = dimensions
                .iter()
                .map(|field| quote_identifier(field))
                .collect::<Vec<_>>()
                .join(", ");
            let order_clause = build_nulls_last_order(&dimensions);
            format!(
                "SELECT {select_dimensions}, {} FROM {table_ident} GROUP BY {group_dimensions} ORDER BY {order_clause}",
                statistic_sql.join(", "),
            )
        };

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut grouped = GroupedStatisticValues::new();
        while let Some(row) = rows.next()? {
            let mut row_member = Vec::with_capacity(row_fields.len());
            let mut column_member = Vec::with_capacity(column_fields.len());
            for index in 0..row_fields.len() {
                let value: Value = row.get(index)?;
                row_member.push(json_dimension_value(value));
            }
            for index in 0..column_fields.len() {
                let value: Value = row.get(row_fields.len() + index)?;
                column_member.push(json_dimension_value(value));
            }

            let mut values = Vec::with_capacity(statistics.len());
            let stats_offset = dimensions.len();
            for stat_index in 0..statistics.len() {
                let value: Value = row.get(stats_offset + stat_index)?;
                values.push(numeric_cell_value(value)?);
            }

            grouped.insert(
                (member_key(&row_member)?, member_key(&column_member)?),
                values,
            );
        }

        Ok(grouped)
    }

    /// Import a CSV file as a new dataset
    pub fn import_csv(
        &self,
        id: &str,
        name: &str,
        file_path: &str,
    ) -> Result<DatasetMeta, AppError> {
        let table_name = format!("dataset_{}", id.replace('-', "_"));

        // Create table from CSV using DuckDB's read_csv
        let create_sql = format!(
            "CREATE TABLE \"{}\" AS SELECT * FROM read_csv($1, auto_detect=true)",
            table_name
        );
        self.conn.execute(&create_sql, params![file_path])?;

        // Get row count
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info
        let mut col_stmt = self.conn.prepare(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position"
        )?;

        let col_count: i32 = {
            let mut rows = col_stmt.query(params![table_name])?;
            let mut count = 0i32;
            let mut col_index = 0i32;
            while let Some(row) = rows.next()? {
                let col_name: String = row.get(0)?;
                let col_type: String = row.get(1)?;
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index, col_name, col_type],
                )?;
                col_index += 1;
                count += 1;
            }
            count
        };

        // Insert dataset metadata
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'csv', $4, $5)",
            params![id, name, file_path, row_count, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Get metadata for a single dataset
    pub fn get_dataset_meta(&self, id: &str) -> Result<DatasetMeta, AppError> {
        let meta = self.conn.query_row(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets WHERE id = $1",
            params![id],
            |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )?;
        Ok(meta)
    }

    /// List all datasets
    pub fn list_datasets(&self) -> Result<Vec<DatasetMeta>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, source_path, source_type, row_count, col_count, created_at, updated_at FROM _meta_datasets ORDER BY created_at DESC",
        )?;

        let datasets = stmt
            .query_map([], |row| {
                Ok(DatasetMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    source_type: row.get(3)?,
                    row_count: row.get(4)?,
                    col_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(datasets)
    }

    /// Delete a dataset and its metadata
    pub fn delete_dataset(&self, id: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", id.replace('-', "_"));
        self.conn
            .execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM _meta_datasets WHERE id = $1", params![id])?;
        Ok(())
    }

    /// Query a dataset table with pagination
    pub fn query_table(
        &self,
        dataset_id: &str,
        page: usize,
        page_size: usize,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<TableQueryResult, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let offset = page * page_size;

        // Get total rows
        let total_rows: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        // Get column info from metadata (avoids DuckDB panic on unexecuted statements)
        let mut col_stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let col_info: Vec<(String, String)> = col_stmt
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // _row_id + user columns
        let mut columns = vec!["_row_id".to_string()];
        let mut column_types = vec!["INTEGER".to_string()];
        for (name, typ) in &col_info {
            columns.push(name.clone());
            column_types.push(typ.clone());
        }

        // Build SELECT with explicit column list
        let select_cols = columns
            .iter()
            .map(|c| format!("\"{}\"", c))
            .collect::<Vec<_>>()
            .join(", ");

        // Build query with optional sorting
        let order_clause = match sort_by {
            Some(col) => {
                let dir = sort_order.unwrap_or("asc");
                let dir = if dir.eq_ignore_ascii_case("desc") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!("ORDER BY \"{}\" {}", col, dir)
            }
            None => String::new(),
        };

        let query = format!(
            "SELECT {} FROM \"{}\" {} LIMIT {} OFFSET {}",
            select_cols, table_name, order_clause, page_size, offset
        );

        // Execute and fetch rows
        let mut stmt = self.conn.prepare(&query)?;
        let mut rows_data: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows = stmt.query([])?;
        let column_count = columns.len();

        while let Some(row) = rows.next()? {
            let mut row_values: Vec<serde_json::Value> = Vec::new();
            for i in 0..column_count {
                let value: duckdb::types::Value = row.get(i)?;
                let json_val = match value {
                    duckdb::types::Value::Null => serde_json::Value::Null,
                    duckdb::types::Value::Boolean(b) => serde_json::Value::Bool(b),
                    duckdb::types::Value::TinyInt(n) => serde_json::json!(n),
                    duckdb::types::Value::SmallInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Int(n) => serde_json::json!(n),
                    duckdb::types::Value::BigInt(n) => serde_json::json!(n),
                    duckdb::types::Value::Float(f) => serde_json::json!(f),
                    duckdb::types::Value::Double(f) => serde_json::json!(f),
                    duckdb::types::Value::Text(s) => serde_json::Value::String(s),
                    _ => serde_json::Value::String(format!("{:?}", value)),
                };
                row_values.push(json_val);
            }
            rows_data.push(row_values);
        }

        Ok(TableQueryResult {
            columns,
            column_types,
            rows: rows_data,
            total_rows,
            page,
            page_size,
        })
    }

    /// Export a dataset to CSV
    pub fn export_csv(&self, dataset_id: &str, output_path: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        self.conn.execute(
            &format!("COPY \"{}\" TO $1 (HEADER, DELIMITER ',')", table_name),
            params![output_path],
        )?;
        Ok(())
    }

    /// Export all datasets as CSV files packed into a ZIP archive.
    ///
    /// This is the parameterized variant used both for "export everything"
    /// and for folder-scoped exports from the UI.
    ///
    /// * `subset` — if `Some`, only datasets whose ids appear in the slice are
    ///   exported; if `None`, all datasets are exported.
    /// * `archive_paths` — optional `dataset_id → path inside the zip` map
    ///   (without the `.csv` suffix). This is how the UI requests folder-aware
    ///   layouts (e.g. `Folder1/Sub/Table.csv`). Datasets not present in the
    ///   map fall back to a sanitized dataset name at the zip root.
    ///
    /// The path inside the zip is automatically suffixed with `.csv` and any
    /// characters that are illegal on Windows are replaced with `_`. The
    /// folder separator `/` is preserved so subfolder hierarchies survive.
    pub fn export_csv_zip_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        archive_paths: &std::collections::HashMap<String, String>,
    ) -> Result<(), AppError> {
        use std::io::Write;

        let datasets = self.list_datasets()?;
        // When a subset is requested, intersect with what actually exists so
        // a stale id from the UI doesn't blow up the whole export.
        let filtered: Vec<DatasetMeta> = match subset {
            Some(ids) => {
                let id_set: std::collections::HashSet<&str> =
                    ids.iter().map(|s| s.as_str()).collect();
                datasets
                    .into_iter()
                    .filter(|d| id_set.contains(d.id.as_str()))
                    .collect()
            }
            None => datasets,
        };
        if filtered.is_empty() {
            return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
        }

        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // Track used archive paths so a (folder, name) clash inside the zip
        // resolves to `name (2).csv`, `name (3).csv`, … instead of overwriting.
        let mut used_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

        for ds in &filtered {
            let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

            // Get user column names (exclude _row_id)
            let mut col_stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )?;
            let col_names: Vec<String> = col_stmt
                .query_map(params![ds.id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;

            if col_names.is_empty() {
                continue;
            }

            let select_cols = col_names
                .iter()
                .map(|c| format!("CAST(\"{}\" AS VARCHAR) AS \"{}\"", c, c))
                .collect::<Vec<_>>()
                .join(", ");

            // Query all data
            let sql = format!("SELECT {} FROM \"{}\"", select_cols, table_name);
            let mut stmt = self.conn.prepare(&sql)?;
            let col_count = col_names.len();
            let mut rows = stmt.query([])?;

            // Build CSV content in memory
            let mut csv_buf = Vec::new();
            // Header
            writeln!(&mut csv_buf, "{}", col_names.join(","))
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            // Data rows
            while let Some(row) = rows.next()? {
                let mut parts = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let val: Option<String> = row.get(i)?;
                    match val {
                        Some(v) => {
                            if v.contains(',') || v.contains('"') || v.contains('\n') {
                                parts.push(format!("\"{}\"", v.replace('"', "\"\"")));
                            } else {
                                parts.push(v);
                            }
                        }
                        None => parts.push(String::new()),
                    }
                }
                writeln!(&mut csv_buf, "{}", parts.join(","))
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
            }

            // Resolve the archive path. We sanitize each path segment so the
            // resulting zip is portable across platforms (Windows is the
            // strictest). Forward slashes between segments are intentionally
            // preserved so subfolders remain.
            let raw_path = archive_paths
                .get(&ds.id)
                .cloned()
                .unwrap_or_else(|| ds.name.clone());
            let safe_base = sanitize_archive_path(&raw_path);
            let file_name = dedupe_archive_path(&safe_base, "csv", &mut used_paths);
            zip.start_file(&file_name, options)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            zip.write_all(&csv_buf)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    }

    /// Import all tables from a SQLite database as datasets
    pub fn import_sqlite<F>(
        &self,
        file_path: &str,
        on_progress: &F,
    ) -> Result<Vec<(String, DatasetMeta)>, AppError>
    where
        F: Fn(&str, usize, usize, usize, usize),
    {
        use rusqlite::types::ValueRef;

        // Open SQLite file directly with rusqlite (bypasses DuckDB's scanner type issues)
        let sqlite_conn = rusqlite::Connection::open_with_flags(
            file_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;

        // List user tables
        let mut table_stmt = sqlite_conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let table_names: Vec<String> = table_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(table_stmt);

        let table_total = table_names.len();

        let mut results = Vec::new();

        for (table_index, src_table) in table_names.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            let table_name = format!("dataset_{}", id.replace('-', "_"));

            // Get column info via PRAGMA table_info
            let mut pragma_stmt =
                sqlite_conn.prepare(&format!("PRAGMA table_info(\"{}\")", src_table))?;
            let columns: Vec<(String, String)> = pragma_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?, // column name
                        row.get::<_, String>(2)?, // column type
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(pragma_stmt);

            if columns.is_empty() {
                continue;
            }

            // Map SQLite types to DuckDB types (date/time types -> VARCHAR)
            let col_defs: Vec<String> = columns
                .iter()
                .map(|(name, sqlite_type)| {
                    let duckdb_type = Self::map_sqlite_type(sqlite_type);
                    format!("\"{}\" {}", name, duckdb_type)
                })
                .collect();

            self.conn.execute(
                &format!(
                    "CREATE TABLE \"{}\" (\"_row_id\" BIGINT, {})",
                    table_name,
                    col_defs.join(", ")
                ),
                [],
            )?;

            // Determine target types for value conversion
            let col_types: Vec<&str> = columns
                .iter()
                .map(|(_, t)| Self::map_sqlite_type(t))
                .collect();

            // Read ALL data from SQLite into memory first, then batch-insert into DuckDB.
            // This avoids holding the DuckDB mutex while doing slow SQLite I/O.
            let col_count = columns.len();
            on_progress(src_table, table_index, table_total, 0, 0); // signal: reading started
            let all_rows: Vec<Vec<String>> = {
                let col_names_sql = columns
                    .iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let select_sql = format!("SELECT {} FROM \"{}\"", col_names_sql, src_table);
                let mut data_stmt = sqlite_conn.prepare(&select_sql)?;
                let mut rows = data_stmt.query([])?;
                let mut collected = Vec::new();

                while let Some(row) = rows.next()? {
                    let mut row_vals = Vec::with_capacity(col_count);
                    for i in 0..col_count {
                        let val_ref = row.get_ref(i)?;
                        let s = match val_ref {
                            ValueRef::Null => "\0NULL\0".to_string(),
                            ValueRef::Integer(v) => v.to_string(),
                            ValueRef::Real(v) => v.to_string(),
                            ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
                            ValueRef::Blob(_) => "\0NULL\0".to_string(),
                        };
                        row_vals.push(s);
                    }
                    collected.push(row_vals);
                }
                collected
            };

            // Batch INSERT using VALUES lists (1000 rows per batch for speed)
            const BATCH_SIZE: usize = 1000;
            let total_rows = all_rows.len();
            let mut rows_done: usize = 0;
            on_progress(src_table, table_index, table_total, 0, total_rows);
            self.conn.execute_batch("BEGIN TRANSACTION")?;

            for chunk in all_rows.chunks(BATCH_SIZE) {
                let mut values_parts: Vec<String> = Vec::with_capacity(chunk.len());
                for (batch_idx, row_vals) in chunk.iter().enumerate() {
                    let row_id = values_parts.len(); // placeholder, will compute below
                    let _ = row_id; // suppress warning
                    let mut col_parts: Vec<String> = Vec::with_capacity(col_count + 1);
                    // _row_id will be added via a subquery
                    for (ci, val) in row_vals.iter().enumerate() {
                        if val == "\0NULL\0" {
                            col_parts.push("NULL".to_string());
                        } else {
                            match col_types[ci] {
                                "BIGINT" => match val.parse::<i64>() {
                                    Ok(v) => col_parts.push(v.to_string()),
                                    Err(_) => col_parts.push("NULL".to_string()),
                                },
                                "DOUBLE" => match val.parse::<f64>() {
                                    Ok(_) => col_parts.push(val.clone()),
                                    Err(_) => col_parts.push("NULL".to_string()),
                                },
                                _ => {
                                    // VARCHAR
                                    col_parts.push(format!("'{}'", val.replace('\'', "''")));
                                }
                            }
                        }
                    }
                    let _ = batch_idx;
                    values_parts.push(format!("({})", col_parts.join(", ")));
                }

                // Use INSERT with row_number() to generate _row_id
                let col_aliases = columns
                    .iter()
                    .map(|(n, _)| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", ");
                let insert_sql = format!(
                    "INSERT INTO \"{}\" SELECT row_number() OVER () + (SELECT COALESCE(MAX(\"_row_id\"), 0) FROM \"{}\"), {} FROM (VALUES {}) AS t({})",
                    table_name, table_name, col_aliases, values_parts.join(", "), col_aliases
                );
                self.conn.execute_batch(&insert_sql)?;
                rows_done += chunk.len();
                on_progress(src_table, table_index, table_total, rows_done, total_rows);
            }

            self.conn.execute_batch("COMMIT")?;

            // Get row count
            let row_count: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )?;

            // Insert column metadata
            let col_count_i32 = columns.len() as i32;
            for (col_index, (col_name, sqlite_type)) in columns.iter().enumerate() {
                let duckdb_type = Self::map_sqlite_type(sqlite_type);
                self.conn.execute(
                    "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                    params![id, col_index as i32, col_name, duckdb_type],
                )?;
            }

            // Insert dataset metadata
            self.conn.execute(
                "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, $3, 'sqlite', $4, $5)",
                params![id, src_table, file_path, row_count, col_count_i32],
            )?;

            let meta = self.get_dataset_meta(&id)?;
            results.push((src_table.clone(), meta));
        }

        Ok(results)
    }

    /// Map SQLite column type to DuckDB type, keeping date/time types as VARCHAR
    fn map_sqlite_type(sqlite_type: &str) -> &'static str {
        let upper = sqlite_type.to_uppercase();
        if upper.contains("INT") || upper.contains("BOOL") {
            "BIGINT"
        } else if upper.contains("REAL")
            || upper.contains("FLOA")
            || upper.contains("DOUB")
            || upper.contains("NUMERIC")
            || upper.contains("DECIMAL")
        {
            "DOUBLE"
        } else {
            "VARCHAR"
        }
    }

    /// Export datasets to a SQLite database file.
    ///
    /// This is the parameterized variant used both for "export everything"
    /// and for folder-scoped exports from the UI.
    ///
    /// * `subset` — if `Some`, only datasets whose ids appear in the slice are
    ///   exported; if `None`, all datasets are exported.
    /// * `name_overrides` — `dataset_id → table name to use in the destination
    ///   SQLite file`. Datasets not present in the map fall back to their
    ///   regular `name`. Used by the UI to encode folder structure into the
    ///   destination as `folder-tablename` (SQLite has no nested namespaces).
    ///
    /// If two datasets would map to the same SQLite table name (because they
    /// share the same `folder-name` after override), the second one is
    /// suffixed with ` (2)`, ` (3)`, … to avoid `CREATE TABLE` collisions.
    pub fn export_sqlite_subset(
        &self,
        output_path: &str,
        subset: Option<&[String]>,
        name_overrides: &std::collections::HashMap<String, String>,
    ) -> Result<(), AppError> {
        // Install and load the sqlite extension
        self.conn.execute_batch("INSTALL sqlite; LOAD sqlite;")?;

        // Delete existing file if present (so we get a fresh database)
        let _ = std::fs::remove_file(output_path);

        // Detach if previously attached (from a failed attempt)
        let _ = self.conn.execute_batch("DETACH IF EXISTS _sqlite_dst;");

        // Attach the output SQLite database
        self.conn.execute(
            &format!(
                "ATTACH '{}' AS _sqlite_dst (TYPE sqlite)",
                output_path.replace('\'', "''")
            ),
            [],
        )?;

        let result = (|| -> Result<(), AppError> {
            let datasets = self.list_datasets()?;
            let filtered: Vec<DatasetMeta> = match subset {
                Some(ids) => {
                    let id_set: std::collections::HashSet<&str> =
                        ids.iter().map(|s| s.as_str()).collect();
                    datasets
                        .into_iter()
                        .filter(|d| id_set.contains(d.id.as_str()))
                        .collect()
                }
                None => datasets,
            };
            if filtered.is_empty() {
                return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
            }

            // Track which SQLite table names we've already emitted so the
            // (folder, name) → table name collisions resolve deterministically.
            let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

            for ds in &filtered {
                let table_name = format!("dataset_{}", ds.id.replace('-', "_"));

                // Get user column names (exclude _row_id)
                let mut col_stmt = self.conn.prepare(
                    "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
                )?;
                let col_names: Vec<String> = col_stmt
                    .query_map(params![ds.id], |row| row.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;

                if col_names.is_empty() {
                    continue;
                }

                let select_cols = col_names
                    .iter()
                    .map(|c| format!("\"{}\" ", c))
                    .collect::<Vec<_>>()
                    .join(", ");

                // Pick the destination table name, then dedupe within this run.
                let base = name_overrides
                    .get(&ds.id)
                    .cloned()
                    .unwrap_or_else(|| ds.name.clone());
                let dst_name = dedupe_sqlite_table_name(&base, &mut used);

                // Create the table in the destination SQLite database
                self.conn.execute(
                    &format!(
                        "CREATE TABLE _sqlite_dst.\"{}\" AS SELECT {} FROM \"{}\"",
                        dst_name.replace('"', "\"\""),
                        select_cols,
                        table_name
                    ),
                    [],
                )?;
            }

            Ok(())
        })();

        // Always detach
        let _ = self.conn.execute_batch("DETACH _sqlite_dst;");

        result
    }

    /// Get basic descriptive stats for a numeric column
    pub fn column_stats(
        &self,
        dataset_id: &str,
        column_name: &str,
    ) -> Result<crate::models::stats::ColumnStats, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        let stats = self.conn.query_row(
            &format!(
                "SELECT
                    COUNT(*) as cnt,
                    COUNT(*) - COUNT(\"{col}\") as missing,
                    AVG(\"{col}\") as mean_val,
                    MEDIAN(\"{col}\") as median_val,
                    STDDEV_SAMP(\"{col}\") as std_val,
                    MIN(\"{col}\") as min_val,
                    MAX(\"{col}\") as max_val,
                    QUANTILE_CONT(\"{col}\", 0.25) as q1_val,
                    QUANTILE_CONT(\"{col}\", 0.75) as q3_val,
                    COUNT(DISTINCT \"{col}\") as unique_cnt
                FROM \"{table}\"",
                col = column_name,
                table = table_name
            ),
            [],
            |row| {
                Ok(crate::models::stats::ColumnStats {
                    column_name: column_name.to_string(),
                    count: row.get(0)?,
                    missing: row.get(1)?,
                    mean: row.get(2)?,
                    median: row.get(3)?,
                    std_dev: row.get(4)?,
                    min: row.get(5)?,
                    max: row.get(6)?,
                    q1: row.get(7)?,
                    q3: row.get(8)?,
                    unique_count: row.get(9)?,
                })
            },
        )?;

        Ok(stats)
    }

    /// Get descriptive stats for all numeric columns in a dataset
    pub fn descriptive_stats(
        &self,
        dataset_id: &str,
    ) -> Result<crate::models::stats::DescriptiveResult, AppError> {
        // Get column list
        let mut stmt = self.conn.prepare(
            "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;

        let col_names: Vec<String> = stmt
            .query_map(params![dataset_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut columns = Vec::new();
        for col_name in &col_names {
            match self.column_stats(dataset_id, col_name) {
                Ok(stats) => columns.push(stats),
                Err(_) => continue, // Skip non-numeric columns
            }
        }

        Ok(crate::models::stats::DescriptiveResult {
            dataset_id: dataset_id.to_string(),
            columns,
        })
    }

    /// Create an empty dataset with specified columns (columns may be empty)
    pub fn create_empty_table(
        &self,
        id: &str,
        name: &str,
        column_names: &[String],
        column_types: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if column_names.len() != column_types.len() {
            return Err(AppError::InvalidParam(
                "Column names and types length mismatch".into(),
            ));
        }

        let table_name = format!("dataset_{}", id.replace('-', "_"));

        // Build column definitions
        let col_defs: Vec<String> = column_names
            .iter()
            .zip(column_types.iter())
            .map(|(name, typ)| format!("\"{}\" {}", name, typ))
            .collect();

        // Add a hidden row_id column for row identification
        let create_sql = if col_defs.is_empty() {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0)",
                table_name
            )
        } else {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Register column metadata
        for (i, (col_name, col_type)) in column_names.iter().zip(column_types.iter()).enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![id, i as i32, col_name, col_type],
            )?;
        }

        // Insert dataset metadata
        let col_count = column_names.len() as i32;
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) VALUES ($1, $2, NULL, 'manual', 0, $3)",
            params![id, name, col_count],
        )?;

        self.get_dataset_meta(id)
    }

    /// Add an empty row to a dataset, returns the new row_id
    pub fn add_row(&self, dataset_id: &str) -> Result<i64, AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Get next row_id
        let max_id: Option<i64> = self
            .conn
            .query_row(
                &format!("SELECT MAX(\"_row_id\") FROM \"{}\"", table_name),
                [],
                |row| row.get(0),
            )
            .unwrap_or(None);
        let new_id = max_id.unwrap_or(0) + 1;

        // Insert row with only _row_id set (other columns NULL)
        self.conn.execute(
            &format!("INSERT INTO \"{}\" (\"_row_id\") VALUES ($1)", table_name),
            params![new_id],
        )?;

        // Update row count in metadata
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count, dataset_id],
        )?;

        Ok(new_id)
    }

    /// Update a cell value
    pub fn update_cell(
        &self,
        dataset_id: &str,
        row_id: i64,
        column_name: &str,
        value: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        if value.is_empty() {
            // Set to NULL when clearing
            let update_sql = format!(
                "UPDATE \"{}\" SET \"{}\" = NULL WHERE \"_row_id\" = $1",
                table_name, column_name
            );
            self.conn.execute(&update_sql, params![row_id])?;
        } else {
            let update_sql = format!(
                "UPDATE \"{}\" SET \"{}\" = $1 WHERE \"_row_id\" = $2",
                table_name, column_name
            );
            self.conn.execute(&update_sql, params![value, row_id])?;
        }
        Ok(())
    }

    /// Delete a row by row_id
    pub fn delete_row(&self, dataset_id: &str, row_id: i64) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        self.conn.execute(
            &format!("DELETE FROM \"{}\" WHERE \"_row_id\" = $1", table_name),
            params![row_id],
        )?;

        // Update row count
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count, dataset_id],
        )?;
        Ok(())
    }

    /// Rename a dataset
    pub fn rename_dataset(&self, dataset_id: &str, new_name: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE _meta_datasets SET name = $1 WHERE id = $2",
            params![new_name, dataset_id],
        )?;
        Ok(())
    }

    /// Add a column to a dataset
    pub fn add_column(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // ALTER TABLE to add column
        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
                table_name, col_name, col_type
            ),
            [],
        )?;

        // Get current max col_index
        let max_idx: Option<i32> = self
            .conn
            .query_row(
                "SELECT MAX(col_index) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        let new_idx = max_idx.unwrap_or(-1) + 1;

        // Insert column metadata
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
            params![dataset_id, new_idx, col_name, col_type],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Insert a new column at a specific visible index (0-based among user
    /// columns). The column is always appended physically — display order is
    /// driven entirely by `_meta_columns.col_index`, so physical position is
    /// irrelevant — then `col_index` values are shifted so the new column lands
    /// at `at_index`. `at_index` is clamped to `[0, col_count]`.
    pub fn insert_column_at(
        &self,
        dataset_id: &str,
        col_name: &str,
        col_type: &str,
        at_index: i32,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Clamp the target index to the current column count.
        let col_count: i32 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
                params![dataset_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let at = at_index.clamp(0, col_count);

        // ALTER TABLE to add the column (appended physically).
        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
                table_name, col_name, col_type
            ),
            [],
        )?;

        // Shift existing columns at/after the insertion point one slot right.
        // DuckDB evaluates the UPDATE set-based, mirroring the decrement used
        // by `delete_column`, so no primary-key clash occurs.
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index + 1 WHERE dataset_id = $1 AND col_index >= $2",
            params![dataset_id, at],
        )?;

        // Register the new column at the freed slot.
        self.conn.execute(
            "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
            params![dataset_id, at, col_name, col_type],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count + 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Move a user column from visible index `from` to visible index `to`,
    /// renumbering every `col_index` so they stay contiguous `0..n`. Both
    /// indices are clamped to the valid range; a no-op move returns `Ok`.
    pub fn reorder_column(&self, dataset_id: &str, from: i32, to: i32) -> Result<(), AppError> {
        // Read the current column order.
        let mut names: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT col_name FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
            )?;
            stmt.query_map(params![dataset_id], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect()
        };

        let n = names.len() as i32;
        if n == 0 {
            return Ok(());
        }
        let from = from.clamp(0, n - 1);
        let to = to.clamp(0, n - 1);
        if from == to {
            return Ok(());
        }

        // Apply the move within the ordered name list.
        let moved = names.remove(from as usize);
        names.insert(to as usize, moved);

        // Offset every col_index out of the target range `0..n` first so the
        // subsequent per-column assignment can't hit a primary-key clash.
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index + $1 WHERE dataset_id = $2",
            params![n + 1000, dataset_id],
        )?;
        for (i, name) in names.iter().enumerate() {
            self.conn.execute(
                "UPDATE _meta_columns SET col_index = $1 WHERE dataset_id = $2 AND col_name = $3",
                params![i as i32, dataset_id, name],
            )?;
        }

        Ok(())
    }

    /// Delete a column from a dataset
    pub fn delete_column(&self, dataset_id: &str, col_name: &str) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // ALTER TABLE to drop column
        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" DROP COLUMN \"{}\"",
                table_name, col_name
            ),
            [],
        )?;

        // Get the index of the deleted column
        let del_idx: i32 = self.conn.query_row(
            "SELECT col_index FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
            |row| row.get(0),
        )?;

        // Delete column metadata
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1 AND col_name = $2",
            params![dataset_id, col_name],
        )?;

        // Re-index remaining columns
        self.conn.execute(
            "UPDATE _meta_columns SET col_index = col_index - 1 WHERE dataset_id = $1 AND col_index > $2",
            params![dataset_id, del_idx],
        )?;

        // Update col_count
        self.conn.execute(
            "UPDATE _meta_datasets SET col_count = col_count - 1 WHERE id = $1",
            params![dataset_id],
        )?;

        Ok(())
    }

    /// Rename a column
    pub fn rename_column(
        &self,
        dataset_id: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" RENAME COLUMN \"{}\" TO \"{}\"",
                table_name, old_name, new_name
            ),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_name = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![new_name, dataset_id, old_name],
        )?;

        Ok(())
    }

    pub fn change_column_type(
        &self,
        dataset_id: &str,
        col_name: &str,
        new_type: &str,
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Pre-validate: check if all non-null values can be cast to the new type
        let check_sql = format!(
            "SELECT COUNT(*) FROM \"{}\" WHERE \"{}\" IS NOT NULL AND TRY_CAST(\"{}\" AS {}) IS NULL",
            table_name, col_name, col_name, new_type
        );
        let fail_count: i64 = self
            .conn
            .query_row(&check_sql, [], |row| row.get(0))
            .map_err(|e| AppError::Database(e.to_string()))?;

        if fail_count > 0 {
            return Err(AppError::InvalidParam(format!(
                "无法将列 \"{}\" 转换为 {}：有 {} 个值无法转换",
                col_name, new_type, fail_count
            )));
        }

        self.conn.execute(
            &format!(
                "ALTER TABLE \"{}\" ALTER COLUMN \"{}\" SET DATA TYPE {} USING \"{}\"::{}",
                table_name, col_name, new_type, col_name, new_type
            ),
            [],
        )?;

        self.conn.execute(
            "UPDATE _meta_columns SET col_type = $1 WHERE dataset_id = $2 AND col_name = $3",
            params![new_type, dataset_id, col_name],
        )?;

        Ok(())
    }

    /// Paste data at a specific position in the dataset.
    /// Creates missing columns/rows as needed, updates cells.
    /// If `header_names` is provided, renames target columns to those names.
    /// For existing empty columns, changes type to detected type.
    ///
    /// Performance: wraps everything in a single transaction, allocates new rows
    /// in bulk, and applies all cell updates via a single `UPDATE ... FROM`
    /// against a temporary patch table. This avoids the O(rows * cols) per-cell
    /// UPDATE pattern, which is catastrophic on a column-store like DuckDB
    /// (each per-cell UPDATE rewrites the entire column block).
    pub fn paste_at_position(
        &self,
        dataset_id: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Wrap the entire operation in a transaction so we get a single commit
        // (instead of one auto-commit per statement) and atomic rollback on error.
        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = self.paste_at_position_inner(
            dataset_id,
            &table_name,
            start_row,
            start_col,
            rows,
            header_names,
            new_col_types,
        );
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(())
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                let _ = self.conn.execute("DROP TABLE IF EXISTS _paste_patch", []);
                Err(e)
            }
        }
    }

    fn paste_at_position_inner(
        &self,
        dataset_id: &str,
        table_name: &str,
        start_row: usize,
        start_col: usize,
        rows: &[Vec<String>],
        header_names: Option<&[String]>,
        new_col_types: &[String],
    ) -> Result<(), AppError> {
        // 1. Get existing columns
        let mut stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let existing_cols: Vec<(String, String)> = stmt
            .query_map(params![dataset_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let num_paste_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let num_paste_rows = rows.len();
        let mut all_col_names: Vec<String> = existing_cols.iter().map(|(n, _)| n.clone()).collect();

        // 2. Determine target column names; create new columns if needed.
        //    Track resolved per-column type so the batch UPDATE can cast correctly.
        let mut paste_col_names: Vec<String> = Vec::with_capacity(num_paste_cols);
        let mut paste_col_types: Vec<String> = Vec::with_capacity(num_paste_cols);
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                paste_col_names.push(existing_cols[target_idx].0.clone());
                paste_col_types.push(existing_cols[target_idx].1.clone());
            } else {
                let col_type = new_col_types
                    .get(c)
                    .map(|s| s.as_str())
                    .unwrap_or("VARCHAR");
                let col_name = if let Some(names) = header_names {
                    let name = names.get(c).map(|s| s.trim()).unwrap_or("");
                    if name.is_empty() {
                        Self::generate_col_name(&all_col_names)
                    } else {
                        // Auto-suffix -2/-3/... if the header collides with an
                        // existing column (or with one created earlier in this
                        // same paste). Avoids DuckDB Catalog Errors like
                        // "Column with name X already exists!".
                        Self::unique_col_name(name, &all_col_names, None)
                    }
                } else {
                    Self::generate_col_name(&all_col_names)
                };
                self.add_column(dataset_id, &col_name, col_type)?;
                all_col_names.push(col_name.clone());
                paste_col_names.push(col_name);
                paste_col_types.push(col_type.to_string());
            }
        }

        // 3. For existing target columns with no data, change type to detected type
        for c in 0..num_paste_cols {
            let target_idx = start_col + c;
            if target_idx < existing_cols.len() {
                let (ref col_name, ref existing_type) = existing_cols[target_idx];
                let detected_type = new_col_types
                    .get(c)
                    .map(|s| s.as_str())
                    .unwrap_or("VARCHAR");
                if existing_type != detected_type {
                    let has_data: i64 = self.conn.query_row(
                        &format!(
                            "SELECT COUNT(*) FROM \"{}\" WHERE \"{}\" IS NOT NULL",
                            table_name, col_name
                        ),
                        [],
                        |row| row.get(0),
                    )?;
                    if has_data == 0 {
                        if self
                            .change_column_type(dataset_id, col_name, detected_type)
                            .is_ok()
                        {
                            paste_col_types[c] = detected_type.to_string();
                        }
                    }
                }
            }
        }

        // 4. Handle header renames for existing columns
        if let Some(names) = header_names {
            for (c, new_name) in names.iter().enumerate() {
                let target_idx = start_col + c;
                if target_idx < existing_cols.len() {
                    let old_name = &paste_col_names[c];
                    let trimmed = new_name.trim();
                    if !trimmed.is_empty() && old_name != trimmed {
                        // Auto-suffix -2/-3/... if the proposed name collides
                        // with any OTHER column. The column being renamed is
                        // excluded so a no-op rename (which we already filter
                        // above) wouldn't have been suffixed anyway.
                        let unique =
                            Self::unique_col_name(trimmed, &all_col_names, Some(target_idx));
                        let unique_owned = unique.clone();
                        self.rename_column(dataset_id, old_name, &unique_owned)?;
                        all_col_names[target_idx] = unique_owned.clone();
                        paste_col_names[c] = unique_owned;
                    }
                }
            }
        }

        // 5. Get existing row_ids in order
        let mut row_stmt = self.conn.prepare(&format!(
            "SELECT \"_row_id\" FROM \"{}\" ORDER BY \"_row_id\"",
            table_name
        ))?;
        let existing_row_ids: Vec<i64> = row_stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(row_stmt);

        // 5b. Bulk-allocate new rows (avoids per-row MAX/COUNT/UPDATE overhead).
        let mut all_row_ids = existing_row_ids;
        let total_target_rows = start_row + num_paste_rows;
        if total_target_rows > all_row_ids.len() {
            let need = total_target_rows - all_row_ids.len();
            let max_id: Option<i64> = self
                .conn
                .query_row(
                    &format!("SELECT MAX(\"_row_id\") FROM \"{}\"", table_name),
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(None);
            let start_new = max_id.unwrap_or(0) + 1;
            let insert_sql = format!("INSERT INTO \"{}\" (\"_row_id\") VALUES ($1)", table_name);
            let mut ins = self.conn.prepare(&insert_sql)?;
            for i in 0..need as i64 {
                let new_id = start_new + i;
                ins.execute(params![new_id])?;
                all_row_ids.push(new_id);
            }
        }

        // 6. Build a temporary patch table and apply all cell updates with a
        //    single multi-column `UPDATE ... FROM`. Each target column is
        //    rewritten exactly once instead of once per pasted row.
        if num_paste_cols > 0 && num_paste_rows > 0 {
            // Defensive cleanup in case a previous error left it behind.
            let _ = self.conn.execute("DROP TABLE IF EXISTS _paste_patch", []);

            let mut create_cols = String::from("\"_row_id\" BIGINT");
            for c in 0..num_paste_cols {
                create_cols.push_str(&format!(", \"c{}\" VARCHAR", c));
            }
            self.conn.execute(
                &format!("CREATE TEMP TABLE _paste_patch ({})", create_cols),
                [],
            )?;

            // Prepared multi-row INSERT (param list: _row_id, c0, c1, ...).
            let mut col_list = String::from("\"_row_id\"");
            let mut placeholders = String::from("$1");
            for c in 0..num_paste_cols {
                col_list.push_str(&format!(", \"c{}\"", c));
                placeholders.push_str(&format!(", ${}", c + 2));
            }
            let insert_sql = format!(
                "INSERT INTO _paste_patch ({}) VALUES ({})",
                col_list, placeholders
            );
            let mut ins = self.conn.prepare(&insert_sql)?;

            for (r, row_data) in rows.iter().enumerate() {
                let target_row_idx = start_row + r;
                if target_row_idx >= all_row_ids.len() {
                    break;
                }
                let row_id = all_row_ids[target_row_idx];

                let mut vals: Vec<Value> = Vec::with_capacity(num_paste_cols + 1);
                vals.push(Value::BigInt(row_id));
                for c in 0..num_paste_cols {
                    let v = row_data.get(c).map(|s| s.as_str()).unwrap_or("");
                    if v.is_empty() {
                        vals.push(Value::Null);
                    } else {
                        vals.push(Value::Text(v.to_string()));
                    }
                }
                ins.execute(params_from_iter(vals.iter()))?;
            }

            // Single UPDATE that touches every paste column at once.
            // COALESCE preserves the previous behavior of skipping empty
            // (NULL in the patch) cells. TRY_CAST keeps the existing column
            // type and simply leaves the original value when a value cannot be
            // cast, mirroring the old "skip on empty" semantics.
            let mut set_clauses: Vec<String> = Vec::with_capacity(num_paste_cols);
            for c in 0..num_paste_cols {
                let col_name = &paste_col_names[c];
                let col_type = &paste_col_types[c];
                set_clauses.push(format!(
                    "\"{cn}\" = COALESCE(TRY_CAST(p.\"c{c}\" AS {ct}), \"{tbl}\".\"{cn}\")",
                    cn = col_name,
                    c = c,
                    ct = col_type,
                    tbl = table_name,
                ));
            }
            let update_sql = format!(
                "UPDATE \"{tbl}\" SET {set} FROM _paste_patch p \
                 WHERE \"{tbl}\".\"_row_id\" = p.\"_row_id\"",
                tbl = table_name,
                set = set_clauses.join(", "),
            );
            self.conn.execute(&update_sql, [])?;

            self.conn.execute("DROP TABLE _paste_patch", [])?;
        }

        // 7. Update metadata counts (once at the end)
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        Ok(())
    }

    fn generate_col_name(existing: &[String]) -> String {
        let mut i = 1;
        loop {
            let name = format!("列{}", i);
            if !existing.contains(&name) {
                return name;
            }
            i += 1;
        }
    }

    /// Resolve a column name that may collide with existing ones.
    ///
    /// Returns `base` unchanged when it's free, otherwise appends `-2`, `-3`,
    /// ... until a non-conflicting name is produced. `exclude_idx`, if given,
    /// designates a slot in `existing` whose current name should NOT count as
    /// a collision (used when renaming a column to a header value that may
    /// equal its own current name).
    fn unique_col_name(base: &str, existing: &[String], exclude_idx: Option<usize>) -> String {
        let in_use = |candidate: &str| -> bool {
            existing
                .iter()
                .enumerate()
                .any(|(i, n)| n == candidate && Some(i) != exclude_idx)
        };
        if !in_use(base) {
            return base.to_string();
        }
        let mut i = 2usize;
        loop {
            let candidate = format!("{}-{}", base, i);
            if !in_use(&candidate) {
                return candidate;
            }
            i += 1;
        }
    }

    /// Restore a table from a full snapshot (columns, types, rows).
    /// Drops all existing data and recreates the table with the given schema and data.
    pub fn restore_snapshot(
        &self,
        dataset_id: &str,
        col_names: &[String],
        col_types: &[String],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<(), AppError> {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        // Drop and recreate the table
        self.conn
            .execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])?;

        let col_defs: Vec<String> = col_names
            .iter()
            .zip(col_types.iter())
            .map(|(name, typ)| format!("\"{}\" {}", name, typ))
            .collect();

        let create_sql = if col_defs.is_empty() {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0)",
                table_name
            )
        } else {
            format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name,
                col_defs.join(", ")
            )
        };
        self.conn.execute(&create_sql, [])?;

        // Rebuild _meta_columns
        self.conn.execute(
            "DELETE FROM _meta_columns WHERE dataset_id = $1",
            params![dataset_id],
        )?;
        for (i, (col_name, col_type)) in col_names.iter().zip(col_types.iter()).enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, $4)",
                params![dataset_id, i as i32, col_name, col_type],
            )?;
        }

        // Insert rows — each row includes _row_id as first element followed by column values
        for row_data in rows {
            if row_data.is_empty() {
                continue;
            }
            // First element is _row_id
            let row_id = match &row_data[0] {
                serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
                _ => 0,
            };

            // Build column list and values for non-null columns
            let mut insert_cols = vec!["\"_row_id\"".to_string()];
            let mut insert_vals = vec![row_id.to_string()];

            for (i, col_name) in col_names.iter().enumerate() {
                let val = row_data.get(i + 1).unwrap_or(&serde_json::Value::Null);
                if val.is_null() {
                    continue;
                }
                insert_cols.push(format!("\"{}\"", col_name));
                match val {
                    serde_json::Value::Bool(b) => insert_vals.push(b.to_string()),
                    serde_json::Value::Number(n) => insert_vals.push(n.to_string()),
                    serde_json::Value::String(s) => {
                        insert_vals.push(format!("'{}'", s.replace('\'', "''")));
                    }
                    _ => insert_vals.push(format!("'{}'", val.to_string().replace('\'', "''"))),
                }
            }

            let sql = format!(
                "INSERT INTO \"{}\" ({}) VALUES ({})",
                table_name,
                insert_cols.join(", "),
                insert_vals.join(", ")
            );
            self.conn.execute(&sql, [])?;
        }

        // Update metadata counts
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;
        let col_count = col_names.len() as i32;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1, col_count = $2 WHERE id = $3",
            params![row_count, col_count, dataset_id],
        )?;

        Ok(())
    }

    // ───────────────────────────────────────────────────────────────
    //  Table operations (JMP-style)
    // ───────────────────────────────────────────────────────────────

    /// Helper: create a new dataset from an arbitrary SELECT query.
    /// Adds `_row_id` via ROW_NUMBER(), registers metadata, returns DatasetMeta.
    fn create_table_from_query(
        &self,
        new_id: &str,
        new_name: &str,
        source_type: &str,
        select_sql: &str,
    ) -> Result<DatasetMeta, AppError> {
        let table_name = format!("dataset_{}", new_id.replace('-', "_"));

        // Create table via CTAS wrapped with _row_id
        let ctas = format!(
            "CREATE TABLE \"{}\" AS SELECT ROW_NUMBER() OVER () AS \"_row_id\", __inner__.* FROM ({}) AS __inner__",
            table_name, select_sql
        );
        self.conn.execute(&ctas, [])?;

        // Collect column info (skip _row_id)
        let col_sql = format!(
            "SELECT column_name, data_type FROM information_schema.columns \
             WHERE table_name = '{}' AND column_name != '_row_id' \
             ORDER BY ordinal_position",
            table_name
        );
        let mut col_stmt = self.conn.prepare(&col_sql)?;
        let mut col_index = 0i32;
        let mut rows = col_stmt.query([])?;
        while let Some(row) = rows.next()? {
            let col_name: String = row.get(0)?;
            let col_type: String = row.get(1)?;
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) \
                 VALUES ($1, $2, $3, $4)",
                params![new_id, col_index, col_name, col_type],
            )?;
            col_index += 1;
        }

        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )?;

        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) \
             VALUES ($1, $2, NULL, $3, $4, $5)",
            params![new_id, new_name, source_type, row_count, col_index],
        )?;

        self.get_dataset_meta(new_id)
    }

    /// Sort: create sorted copy of a dataset
    pub fn sort_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        sort_cols: &[String],
        sort_orders: &[String],
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        // Get user columns (skip _row_id)
        let cols = self.get_user_columns(source_id)?;
        let select_cols = cols
            .iter()
            .map(|(n, _)| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ");

        let order_parts: Vec<String> = sort_cols
            .iter()
            .zip(sort_orders.iter())
            .map(|(col, ord)| {
                let dir = if ord.eq_ignore_ascii_case("desc") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!("\"{}\" {}", col, dir)
            })
            .collect();

        let sql = format!(
            "SELECT {} FROM \"{}\" ORDER BY {}",
            select_cols,
            src_table,
            order_parts.join(", ")
        );
        self.create_table_from_query(new_id, new_name, "sort", &sql)
    }

    /// Subset: create a subset from selected columns and optional row filter
    pub fn subset_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        columns: &[String],       // empty = all
        row_filter: Option<&str>, // SQL WHERE clause (e.g. "age > 18")
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        let user_cols = self.get_user_columns(source_id)?;

        let select_cols = if columns.is_empty() {
            user_cols
                .iter()
                .map(|(n, _)| format!("\"{}\"", n))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            columns
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let where_clause = match row_filter {
            Some(f) if !f.trim().is_empty() => format!(" WHERE {}", f),
            _ => String::new(),
        };

        let sql = format!(
            "SELECT {} FROM \"{}\"{}",
            select_cols, src_table, where_clause
        );
        self.create_table_from_query(new_id, new_name, "subset", &sql)
    }

    /// Transpose: swap rows and columns
    pub fn transpose_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));
        let user_cols = self.get_user_columns(source_id)?;
        if user_cols.is_empty() {
            return Err(AppError::InvalidParam("Source table has no columns".into()));
        }

        // Fetch all rows
        let select_cols = user_cols
            .iter()
            .map(|(n, _)| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT {} FROM \"{}\" ORDER BY \"_row_id\"",
            select_cols, src_table
        );
        let mut stmt = self.conn.prepare(&query)?;
        let mut rows_iter = stmt.query([])?;
        let mut all_rows: Vec<Vec<String>> = Vec::new();
        while let Some(row) = rows_iter.next()? {
            let mut r = Vec::new();
            for i in 0..user_cols.len() {
                let v: duckdb::types::Value = row.get(i)?;
                r.push(self.value_to_string(&v));
            }
            all_rows.push(r);
        }

        // Build transposed table:
        // First column = original column names ("Label")
        // Remaining columns = Row1, Row2, ...
        let n_new_cols = all_rows.len() + 1; // Label + each original row
        let mut new_col_names: Vec<String> = vec!["Label".to_string()];
        for i in 0..all_rows.len() {
            new_col_names.push(format!("Row{}", i + 1));
        }
        let new_col_types: Vec<String> = vec!["VARCHAR".to_string(); n_new_cols];

        let table_name = format!("dataset_{}", new_id.replace('-', "_"));
        let col_defs = new_col_names
            .iter()
            .zip(new_col_types.iter())
            .map(|(n, t)| format!("\"{}\" {}", n, t))
            .collect::<Vec<_>>()
            .join(", ");
        self.conn.execute(
            &format!(
                "CREATE TABLE \"{}\" (\"_row_id\" INTEGER DEFAULT 0, {})",
                table_name, col_defs
            ),
            [],
        )?;

        // Insert transposed rows
        for (ci, (col_name, _)) in user_cols.iter().enumerate() {
            let mut vals = vec![
                (ci as i64 + 1).to_string(),                   // _row_id
                format!("'{}'", col_name.replace('\'', "''")), // Label
            ];
            for row in &all_rows {
                let v = &row[ci];
                if v == "NULL" {
                    vals.push("NULL".to_string());
                } else {
                    vals.push(format!("'{}'", v.replace('\'', "''")));
                }
            }
            let insert = format!(
                "INSERT INTO \"{}\" (\"_row_id\", {}) VALUES ({})",
                table_name,
                new_col_names
                    .iter()
                    .map(|n| format!("\"{}\"", n))
                    .collect::<Vec<_>>()
                    .join(", "),
                vals.join(", ")
            );
            self.conn.execute(&insert, [])?;
        }

        // Register metadata
        for (i, name) in new_col_names.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES ($1, $2, $3, 'VARCHAR')",
                params![new_id, i as i32, name],
            )?;
        }
        self.conn.execute(
            "INSERT INTO _meta_datasets (id, name, source_path, source_type, row_count, col_count) \
             VALUES ($1, $2, NULL, 'transpose', $3, $4)",
            params![new_id, new_name, user_cols.len() as i64, n_new_cols as i32],
        )?;
        self.get_dataset_meta(new_id)
    }

    /// Stack: reshape wide to long (multiple columns → label + value)
    pub fn stack_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        stack_cols: &[String], // columns to stack (become values)
        id_cols: &[String],    // columns to keep as identifiers
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        let id_select = if id_cols.is_empty() {
            String::new()
        } else {
            id_cols
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ")
                + ", "
        };

        // UNION ALL for each stacked column
        // Let DuckDB resolve common type across the UNION ALL branches
        let unions: Vec<String> = stack_cols
            .iter()
            .map(|col| {
                format!(
                    "SELECT {}'{}' AS \"Label\", \"{}\" AS \"Value\" FROM \"{}\"",
                    id_select,
                    col.replace('\'', "''"),
                    col,
                    src_table,
                )
            })
            .collect();

        let sql = unions.join(" UNION ALL ");
        self.create_table_from_query(new_id, new_name, "stack", &sql)
    }

    /// Split: reshape long to wide (pivot label+value → multiple columns)
    pub fn split_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        split_col: &str,    // column containing new column names
        value_col: &str,    // column containing values
        id_cols: &[String], // grouping columns
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        // Get distinct values of split_col to become new column names
        let distinct_sql = format!(
            "SELECT DISTINCT CAST(\"{}\" AS VARCHAR) AS v FROM \"{}\" WHERE \"{}\" IS NOT NULL ORDER BY v",
            split_col, src_table, split_col
        );
        let mut stmt = self.conn.prepare(&distinct_sql)?;
        let mut rows = stmt.query([])?;
        let mut pivot_vals: Vec<String> = Vec::new();
        while let Some(row) = rows.next()? {
            let v: String = row.get(0)?;
            pivot_vals.push(v);
        }
        if pivot_vals.is_empty() {
            return Err(AppError::InvalidParam(
                "Split column has no non-null values".into(),
            ));
        }

        let id_group = if id_cols.is_empty() {
            // Use all columns except split and value as id
            let user_cols = self.get_user_columns(source_id)?;
            user_cols
                .iter()
                .filter(|(n, _)| n != split_col && n != value_col)
                .map(|(n, _)| n.clone())
                .collect::<Vec<_>>()
        } else {
            id_cols.to_vec()
        };

        let id_select = id_group
            .iter()
            .map(|c| format!("\"{}\"", c))
            .collect::<Vec<_>>()
            .join(", ");
        let pivot_cols: Vec<String> = pivot_vals
            .iter()
            .map(|v| {
                format!(
                    "MAX(CASE WHEN CAST(\"{}\" AS VARCHAR) = '{}' THEN \"{}\" END) AS \"{}\"",
                    split_col,
                    v.replace('\'', "''"),
                    value_col,
                    v.replace('"', "\"\"")
                )
            })
            .collect();

        // Add a within-group row number so that duplicate (id_group, split_col) rows
        // are preserved as separate output rows instead of being collapsed by MAX.
        let partition_cols = if id_group.is_empty() {
            format!("\"{}\"", split_col)
        } else {
            format!("{}, \"{}\"", id_select, split_col)
        };
        let cte = format!(
            "SELECT *, ROW_NUMBER() OVER (PARTITION BY {} ORDER BY \"_row_id\") AS _split_rn FROM \"{}\"",
            partition_cols, src_table
        );

        let sql = if id_group.is_empty() {
            format!(
                "SELECT {} FROM ({}) AS _src GROUP BY _split_rn ORDER BY _split_rn",
                pivot_cols.join(", "),
                cte
            )
        } else {
            format!(
                "SELECT {}, {} FROM ({}) AS _src GROUP BY {}, _split_rn ORDER BY {}, _split_rn",
                id_select,
                pivot_cols.join(", "),
                cte,
                id_select,
                id_select
            )
        };

        self.create_table_from_query(new_id, new_name, "split", &sql)
    }

    /// Summary: compute descriptive statistics grouped by optional columns
    pub fn summary_table(
        &self,
        new_id: &str,
        new_name: &str,
        source_id: &str,
        stat_cols: &[String],  // columns to summarize
        group_cols: &[String], // group-by columns (can be empty)
        statistics: &[String], // which stats: "n", "mean", "std", "min", "max", "sum", "median"
    ) -> Result<DatasetMeta, AppError> {
        let src_table = format!("dataset_{}", source_id.replace('-', "_"));

        let mut select_parts: Vec<String> = Vec::new();

        // Group-by columns first
        for gc in group_cols {
            select_parts.push(format!("\"{}\"", gc));
        }

        // Stats for each stat_col
        for sc in stat_cols {
            for stat in statistics {
                let expr = match stat.as_str() {
                    "n" => format!("COUNT(\"{}\") AS \"{}_N\"", sc, sc),
                    "mean" => format!("AVG(CAST(\"{}\" AS DOUBLE)) AS \"{}_Mean\"", sc, sc),
                    "std" => format!("STDDEV(CAST(\"{}\" AS DOUBLE)) AS \"{}_Std\"", sc, sc),
                    "min" => format!("MIN(\"{}\") AS \"{}_Min\"", sc, sc),
                    "max" => format!("MAX(\"{}\") AS \"{}_Max\"", sc, sc),
                    "sum" => format!("SUM(CAST(\"{}\" AS DOUBLE)) AS \"{}_Sum\"", sc, sc),
                    "median" => format!("MEDIAN(CAST(\"{}\" AS DOUBLE)) AS \"{}_Median\"", sc, sc),
                    _ => continue,
                };
                select_parts.push(expr);
            }
        }

        if select_parts.is_empty() {
            return Err(AppError::InvalidParam("No statistics specified".into()));
        }

        let group_clause = if group_cols.is_empty() {
            String::new()
        } else {
            format!(
                " GROUP BY {}",
                group_cols
                    .iter()
                    .map(|c| format!("\"{}\"", c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let sql = format!(
            "SELECT {} FROM \"{}\"{}",
            select_parts.join(", "),
            src_table,
            group_clause
        );
        self.create_table_from_query(new_id, new_name, "summary", &sql)
    }

    /// Join: join two tables
    pub fn join_tables(
        &self,
        new_id: &str,
        new_name: &str,
        left_id: &str,
        right_id: &str,
        join_type: &str, // "inner", "left", "right", "full"
        left_key: &str,
        right_key: &str,
    ) -> Result<DatasetMeta, AppError> {
        let left_table = format!("dataset_{}", left_id.replace('-', "_"));
        let right_table = format!("dataset_{}", right_id.replace('-', "_"));
        let left_cols = self.get_user_columns(left_id)?;
        let right_cols = self.get_user_columns(right_id)?;

        let join_kw = match join_type.to_lowercase().as_str() {
            "left" => "LEFT JOIN",
            "right" => "RIGHT JOIN",
            "full" => "FULL OUTER JOIN",
            _ => "INNER JOIN",
        };

        // Build select: all left cols as-is, right cols with _r suffix for conflicts
        let mut select_parts: Vec<String> = Vec::new();
        let left_names: std::collections::HashSet<&str> =
            left_cols.iter().map(|(n, _)| n.as_str()).collect();

        for (n, _) in &left_cols {
            select_parts.push(format!("L.\"{}\"", n));
        }
        for (n, _) in &right_cols {
            if left_names.contains(n.as_str()) {
                select_parts.push(format!("R.\"{}\" AS \"{}_r\"", n, n));
            } else {
                select_parts.push(format!("R.\"{}\"", n));
            }
        }

        let sql = format!(
            "SELECT {} FROM \"{}\" AS L {} \"{}\" AS R ON L.\"{}\" = R.\"{}\"",
            select_parts.join(", "),
            left_table,
            join_kw,
            right_table,
            left_key,
            right_key
        );
        self.create_table_from_query(new_id, new_name, "join", &sql)
    }

    /// Update: update left table using values from right table
    pub fn update_table(
        &self,
        left_id: &str,
        right_id: &str,
        match_col: &str,
        update_cols: &[String], // columns to update from right into left
    ) -> Result<(), AppError> {
        let left_table = format!("dataset_{}", left_id.replace('-', "_"));
        let right_table = format!("dataset_{}", right_id.replace('-', "_"));

        for col in update_cols {
            let sql = format!(
                "UPDATE \"{}\" SET \"{}\" = R.\"{}\" FROM \"{}\" AS R \
                 WHERE \"{}\".\"{}\" = R.\"{}\"",
                left_table, col, col, right_table, left_table, match_col, match_col
            );
            self.conn.execute(&sql, [])?;
        }

        // Refresh metadata counts
        let row_count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", left_table),
            [],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![row_count, left_id],
        )?;

        Ok(())
    }

    /// Concatenate: vertically stack multiple tables
    pub fn concatenate_tables(
        &self,
        new_id: &str,
        new_name: &str,
        source_ids: &[String],
    ) -> Result<DatasetMeta, AppError> {
        if source_ids.is_empty() {
            return Err(AppError::InvalidParam("No source tables specified".into()));
        }

        // Collect union of all column names (in order of first appearance)
        let mut all_cols: Vec<(String, String)> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for sid in source_ids {
            let cols = self.get_user_columns(sid)?;
            for (name, typ) in cols {
                if seen.insert(name.clone()) {
                    all_cols.push((name, typ));
                }
            }
        }

        // Build UNION ALL: for each source, SELECT known cols or NULL for missing
        let unions: Vec<String> = source_ids
            .iter()
            .map(|sid| {
                let src_table = format!("dataset_{}", sid.replace('-', "_"));
                let src_cols: std::collections::HashSet<String> = self
                    .get_user_columns(sid)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(n, _)| n)
                    .collect();
                let selects: Vec<String> = all_cols
                    .iter()
                    .map(|(name, _)| {
                        if src_cols.contains(name) {
                            format!("\"{}\"", name)
                        } else {
                            format!("NULL AS \"{}\"", name)
                        }
                    })
                    .collect();
                format!("SELECT {} FROM \"{}\"", selects.join(", "), src_table)
            })
            .collect();

        let sql = unions.join(" UNION ALL ");
        self.create_table_from_query(new_id, new_name, "concatenate", &sql)
    }

    /// Helper: get user columns (excluding _row_id) for a dataset (public for service layer)
    pub fn get_user_columns(&self, dataset_id: &str) -> Result<Vec<(String, String)>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index",
        )?;
        let cols = stmt
            .query_map(params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(cols)
    }

    /// Helper: convert DuckDB value to string for transpose
    fn value_to_string(&self, v: &duckdb::types::Value) -> String {
        match v {
            duckdb::types::Value::Null => "NULL".to_string(),
            duckdb::types::Value::Boolean(b) => b.to_string(),
            duckdb::types::Value::TinyInt(n) => n.to_string(),
            duckdb::types::Value::SmallInt(n) => n.to_string(),
            duckdb::types::Value::Int(n) => n.to_string(),
            duckdb::types::Value::BigInt(n) => n.to_string(),
            duckdb::types::Value::Float(f) => f.to_string(),
            duckdb::types::Value::Double(f) => f.to_string(),
            duckdb::types::Value::Text(s) => s.clone(),
            _ => format!("{:?}", v),
        }
    }
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

struct PercentageTransformContext<'a> {
    row_count: usize,
    column_count: usize,
    cells: &'a mut [Option<f64>],
    row_totals: &'a mut [Option<f64>],
    column_totals: &'a mut [Option<f64>],
    grand_totals: &'a mut [Option<f64>],
    raw_row_totals: &'a [Option<f64>],
    raw_column_totals: &'a [Option<f64>],
    raw_grand_totals: &'a [Option<f64>],
}

fn aggregate_sql(statistic: &TabulateStatistic) -> Result<String, AppError> {
    let field = quote_identifier(&statistic.field);
    let expression = match statistic.kind {
        StatisticKind::Count => format!("CAST(COUNT({field}) AS DOUBLE)"),
        StatisticKind::MissingCount => {
            format!("CAST(COUNT(*) - COUNT({field}) AS DOUBLE)")
        }
        StatisticKind::UniqueCount => format!("CAST(COUNT(DISTINCT {field}) AS DOUBLE)"),
        StatisticKind::Sum => format!("CAST(SUM({field}) AS DOUBLE)"),
        StatisticKind::Mean => format!("CAST(AVG({field}) AS DOUBLE)"),
        StatisticKind::StandardDeviation => format!("CAST(STDDEV_SAMP({field}) AS DOUBLE)"),
        StatisticKind::Variance => format!("CAST(VAR_SAMP({field}) AS DOUBLE)"),
        StatisticKind::Minimum => format!("CAST(MIN({field}) AS DOUBLE)"),
        StatisticKind::Maximum => format!("CAST(MAX({field}) AS DOUBLE)"),
        StatisticKind::Median => format!("CAST(MEDIAN({field}) AS DOUBLE)"),
        StatisticKind::Range => format!("CAST(MAX({field}) - MIN({field}) AS DOUBLE)"),
        StatisticKind::Quantile => {
            let probability = statistic.quantile.ok_or_else(|| {
                AppError::InvalidParam(format!(
                    "Quantile statistic '{}' requires quantile",
                    statistic.id
                ))
            })?;
            format!("CAST(QUANTILE_CONT({field}, {}) AS DOUBLE)", probability)
        }
        StatisticKind::RowPercentage
        | StatisticKind::ColumnPercentage
        | StatisticKind::TotalPercentage => format!("CAST(COUNT({field}) AS DOUBLE)"),
    };
    Ok(expression)
}

fn grouped_cardinality(
    conn: &Connection,
    table_name: &str,
    dimensions: &[String],
) -> Result<u64, AppError> {
    if dimensions.is_empty() {
        return Ok(1);
    }

    let table_ident = quote_identifier(table_name);
    let group_dimensions = dimensions
        .iter()
        .map(|field| quote_identifier(field))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM {table_ident} GROUP BY {group_dimensions}) AS \"__groups\""
    );
    let count: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    u64::try_from(count).map_err(|_| AppError::InvalidParam("Tabulate result size overflow".into()))
}

fn json_dimension_value(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(inner) => serde_json::Value::Bool(inner),
        Value::TinyInt(inner) => serde_json::json!(inner),
        Value::SmallInt(inner) => serde_json::json!(inner),
        Value::Int(inner) => serde_json::json!(inner),
        Value::BigInt(inner) => serde_json::json!(inner),
        Value::Float(inner) => serde_json::json!(inner),
        Value::Double(inner) => serde_json::json!(inner),
        Value::Text(inner) => serde_json::json!(inner),
        other => serde_json::json!(format!("{:?}", other)),
    }
}

fn numeric_cell_value(value: Value) -> Result<Option<f64>, AppError> {
    match value {
        Value::Null => Ok(None),
        Value::TinyInt(inner) => Ok(Some(inner as f64)),
        Value::SmallInt(inner) => Ok(Some(inner as f64)),
        Value::Int(inner) => Ok(Some(inner as f64)),
        Value::BigInt(inner) => Ok(Some(inner as f64)),
        Value::Float(inner) => Ok(Some(inner as f64)),
        Value::Double(inner) => Ok(Some(inner)),
        other => Err(AppError::Database(format!(
            "Unexpected non-numeric aggregate value: {:?}",
            other
        ))),
    }
}

fn member_key(members: &[serde_json::Value]) -> Result<String, AppError> {
    serde_json::to_string(members).map_err(|error| AppError::InvalidParam(error.to_string()))
}

fn build_nulls_last_order(dimensions: &[String]) -> String {
    dimensions
        .iter()
        .flat_map(|field| {
            let ident = quote_identifier(field);
            [format!("{ident} IS NULL"), ident]
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn validate_unique_fields(role: &str, fields: &[String]) -> Result<(), AppError> {
    let mut seen = std::collections::HashSet::new();
    for field in fields {
        if !seen.insert(field) {
            return Err(AppError::InvalidParam(format!(
                "duplicate {role} field: {field}",
            )));
        }
    }
    Ok(())
}

fn requires_numeric_field(kind: &StatisticKind) -> bool {
    matches!(
        kind,
        StatisticKind::Sum
            | StatisticKind::Mean
            | StatisticKind::StandardDeviation
            | StatisticKind::Variance
            | StatisticKind::Minimum
            | StatisticKind::Maximum
            | StatisticKind::Median
            | StatisticKind::Range
            | StatisticKind::Quantile
    )
}

fn is_numeric_type(data_type: &str) -> bool {
    matches!(
        base_data_type(data_type),
        "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "BIGINT"
            | "UTINYINT"
            | "USMALLINT"
            | "UINTEGER"
            | "UBIGINT"
            | "HUGEINT"
            | "UHUGEINT"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "DECIMAL"
            | "NUMERIC"
    )
}

fn base_data_type(data_type: &str) -> &str {
    let trimmed = data_type.trim();
    trimmed.split_once('(').map_or(trimmed, |(base, _)| base)
}

fn dimension_select_expression(
    field: &str,
    column_types: &std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    let data_type = column_types
        .get(field)
        .ok_or_else(|| AppError::InvalidParam(format!("Unknown field: {field}")))?;
    let identifier = quote_identifier(field);
    let expression = match base_data_type(data_type) {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "UTINYINT" | "USMALLINT"
        | "UINTEGER" | "UBIGINT" | "FLOAT" | "REAL" | "DOUBLE" | "VARCHAR" => identifier,
        _ => format!("CAST({identifier} AS VARCHAR)"),
    };
    Ok(expression)
}

fn default_missing_value(kind: &StatisticKind) -> Option<f64> {
    if matches!(
        kind,
        StatisticKind::Count
            | StatisticKind::MissingCount
            | StatisticKind::UniqueCount
            | StatisticKind::RowPercentage
            | StatisticKind::ColumnPercentage
            | StatisticKind::TotalPercentage
    ) {
        Some(0.0)
    } else {
        None
    }
}

fn divide_or_null(numerator: Option<f64>, denominator: Option<f64>) -> Option<f64> {
    match (numerator, denominator) {
        (Some(value), Some(total)) if total != 0.0 => Some(value / total),
        _ => None,
    }
}

fn flattened_total_value(
    values: &[Option<f64>],
    outer_index: usize,
    statistic_index: usize,
    statistic_count: usize,
) -> Option<f64> {
    values
        .get(outer_index * statistic_count + statistic_index)
        .copied()
        .flatten()
}

fn transform_percentage_values(
    statistics: &[TabulateStatistic],
    context: &mut PercentageTransformContext<'_>,
) {
    let statistic_count = statistics.len();

    for (statistic_index, statistic) in statistics.iter().enumerate() {
        let raw_grand_total = context
            .raw_grand_totals
            .get(statistic_index)
            .copied()
            .flatten();
        match statistic.kind {
            StatisticKind::RowPercentage => {
                for row_index in 0..context.row_count {
                    let denominator = flattened_total_value(
                        context.raw_row_totals,
                        row_index,
                        statistic_index,
                        statistic_count,
                    );
                    for column_index in 0..context.column_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], denominator);
                    }

                    if !context.row_totals.is_empty() {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            denominator,
                        );
                    }
                }

                if !context.column_totals.is_empty() {
                    for column_index in 0..context.column_count {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            StatisticKind::ColumnPercentage => {
                for column_index in 0..context.column_count {
                    let denominator = flattened_total_value(
                        context.raw_column_totals,
                        column_index,
                        statistic_index,
                        statistic_count,
                    );
                    for row_index in 0..context.row_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], denominator);
                    }

                    if !context.column_totals.is_empty() {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            denominator,
                        );
                    }
                }

                if !context.row_totals.is_empty() {
                    for row_index in 0..context.row_count {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            StatisticKind::TotalPercentage => {
                for row_index in 0..context.row_count {
                    for column_index in 0..context.column_count {
                        let cell_index = ((row_index * context.column_count) + column_index)
                            * statistic_count
                            + statistic_index;
                        context.cells[cell_index] =
                            divide_or_null(context.cells[cell_index], raw_grand_total);
                    }

                    if !context.row_totals.is_empty() {
                        let total_index = row_index * statistic_count + statistic_index;
                        context.row_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_row_totals,
                                row_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.column_totals.is_empty() {
                    for column_index in 0..context.column_count {
                        let total_index = column_index * statistic_count + statistic_index;
                        context.column_totals[total_index] = divide_or_null(
                            flattened_total_value(
                                context.raw_column_totals,
                                column_index,
                                statistic_index,
                                statistic_count,
                            ),
                            raw_grand_total,
                        );
                    }
                }

                if !context.grand_totals.is_empty() {
                    context.grand_totals[statistic_index] =
                        divide_or_null(raw_grand_total, raw_grand_total);
                }
            }
            _ => {}
        }
    }
}

// ---- Free helpers for archive path / SQLite table name sanitization -------

/// Sanitize a path destined for a ZIP archive. Each path segment is cleaned
/// of characters that are illegal on Windows so the zip can be extracted
/// anywhere; the `/` separator between segments is preserved so folder
/// structure survives. Empty segments and leading/trailing whitespace are
/// trimmed per segment.
fn sanitize_archive_path(raw: &str) -> String {
    let parts: Vec<String> = raw
        .split('/')
        .map(|seg| {
            seg.replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                .trim()
                .trim_matches('.')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        "Untitled".to_string()
    } else {
        parts.join("/")
    }
}

/// Suffix `base.ext` with ` (2)`, ` (3)`, … until the result is unique within
/// `used`, then insert into `used` and return the chosen archive path.
fn dedupe_archive_path(
    base: &str,
    ext: &str,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let mut candidate = format!("{}.{}", base, ext);
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({}).{}", base, n, ext);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

/// Suffix a SQLite destination table name with ` (2)`, ` (3)`, … until the
/// result is unique within `used`. SQLite table names allow most characters
/// inside quoted identifiers, so we only enforce uniqueness — no character
/// sanitization is applied (the UI passes `folder-tablename` style names
/// that the user explicitly chose).
fn dedupe_sqlite_table_name(base: &str, used: &mut std::collections::HashSet<String>) -> String {
    let safe_base = if base.trim().is_empty() {
        "Untitled"
    } else {
        base
    };
    let mut candidate = safe_base.to_string();
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({})", safe_base, n);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::tabulate::{StatisticKind, TabulateRequest, TabulateStatistic};
    use serde_json::{json, Value};

    fn assert_option_close(actual: Option<f64>, expected: f64) {
        let value = actual.expect("expected numeric value");
        assert!(
            (value - expected).abs() < 1e-9,
            "expected {expected}, got {value}"
        );
    }

    fn statistic_index(result: &TabulateResult, id: &str) -> usize {
        result
            .statistics
            .iter()
            .position(|statistic| statistic.id == id)
            .expect("statistic id present")
    }

    fn cell_value(
        result: &TabulateResult,
        row: usize,
        column: usize,
        statistic_id: &str,
    ) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.cells
            [((row * result.column_members.len()) + column) * statistic_count + statistic_index]
    }

    fn row_total_value(result: &TabulateResult, row: usize, statistic_id: &str) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.row_totals[row * statistic_count + statistic_index]
    }

    fn column_total_value(
        result: &TabulateResult,
        column: usize,
        statistic_id: &str,
    ) -> Option<f64> {
        let statistic_index = statistic_index(result, statistic_id);
        let statistic_count = result.statistics.len();
        result.column_totals[column * statistic_count + statistic_index]
    }

    fn grand_total_value(result: &TabulateResult, statistic_id: &str) -> Option<f64> {
        result.grand_totals[statistic_index(result, statistic_id)]
    }

    fn make_statistic(id: &str, field: &str, kind: StatisticKind) -> TabulateStatistic {
        TabulateStatistic {
            id: id.to_string(),
            field: field.to_string(),
            kind,
            quantile: None,
        }
    }

    fn make_request(
        row_fields: Vec<&str>,
        column_fields: Vec<&str>,
        statistics: Vec<TabulateStatistic>,
    ) -> TabulateRequest {
        TabulateRequest {
            dataset_id: "tabulate_fixture".to_string(),
            row_fields: row_fields.into_iter().map(str::to_string).collect(),
            column_fields: column_fields.into_iter().map(str::to_string).collect(),
            statistics,
            include_row_totals: false,
            include_column_totals: false,
            max_result_cells: 10_000,
        }
    }

    fn repeated_count_statistics(count: usize) -> Vec<TabulateStatistic> {
        (0..count)
            .map(|index| {
                make_statistic(
                    &format!("count-sales-{index}"),
                    "sales",
                    StatisticKind::Count,
                )
            })
            .collect()
    }

    fn make_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .create_empty_table(
                "tabulate_fixture",
                "Tabulate Fixture",
                &[
                    "region".to_string(),
                    "product".to_string(),
                    "sales".to_string(),
                ],
                &[
                    "VARCHAR".to_string(),
                    "VARCHAR".to_string(),
                    "DOUBLE".to_string(),
                ],
            )
            .expect("fixture metadata");

        for (region, product, sales) in [
            (Some("East"), "A", Some("10")),
            (Some("East"), "A", Some("20")),
            (Some("East"), "B", None),
            (Some("West"), "A", Some("30")),
            (None, "A", Some("40")),
        ] {
            let row_id = engine.add_row("tabulate_fixture").expect("row id");
            if let Some(region_value) = region {
                engine
                    .update_cell("tabulate_fixture", row_id, "region", region_value)
                    .expect("region cell");
            }
            engine
                .update_cell("tabulate_fixture", row_id, "product", product)
                .expect("product cell");
            if let Some(sales_value) = sales {
                engine
                    .update_cell("tabulate_fixture", row_id, "sales", sales_value)
                    .expect("sales cell");
            }
        }

        engine
    }

    fn make_empty_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .create_empty_table(
                "tabulate_fixture",
                "Empty Tabulate Fixture",
                &[
                    "region".to_string(),
                    "product".to_string(),
                    "sales".to_string(),
                ],
                &[
                    "VARCHAR".to_string(),
                    "VARCHAR".to_string(),
                    "DOUBLE".to_string(),
                ],
            )
            .expect("fixture metadata");

        engine
    }

    fn make_typed_dimension_fixture_engine() -> DuckDbEngine {
        let engine = DuckDbEngine::new_in_memory().expect("in-memory engine");
        engine
            .conn
            .execute_batch(
                "
                CREATE TABLE dataset_tabulate_fixture (
                    _row_id INTEGER,
                    amount DECIMAL(18, 2),
                    event_date DATE,
                    event_time TIMESTAMP,
                    duration INTERVAL
                );
                INSERT INTO dataset_tabulate_fixture VALUES
                    (1, 12.50, DATE '2026-08-13', TIMESTAMP '2026-08-13 09:10:11', INTERVAL '2 days');
                INSERT INTO _meta_datasets (id, name, source_type, row_count, col_count)
                    VALUES ('tabulate_fixture', 'Typed Fixture', 'test', 1, 4);
                INSERT INTO _meta_columns (dataset_id, col_index, col_name, col_type) VALUES
                    ('tabulate_fixture', 0, 'amount', 'DECIMAL(18,2)'),
                    ('tabulate_fixture', 1, 'event_date', 'DATE'),
                    ('tabulate_fixture', 2, 'event_time', 'TIMESTAMP'),
                    ('tabulate_fixture', 3, 'duration', 'INTERVAL');
                ",
            )
            .expect("typed fixture");
        engine
    }

    #[test]
    fn tabulate_returns_normalized_row_major_cells() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("count-sales", "sales", StatisticKind::Count),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![vec![json!("East")], vec![json!("West")], vec![Value::Null],]
        );
        assert_eq!(
            result.column_members,
            vec![vec![json!("A")], vec![json!("B")]]
        );
        assert_eq!(
            result.cells,
            vec![
                Some(15.0),
                Some(2.0),
                None,
                Some(0.0),
                Some(30.0),
                Some(1.0),
                None,
                Some(0.0),
                Some(40.0),
                Some(1.0),
                None,
                Some(0.0),
            ]
        );
        assert_eq!(result.cell_count, 12);
    }

    #[test]
    fn tabulate_supports_one_axis_input() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![vec![json!("East")], vec![json!("West")], vec![Value::Null],]
        );
        assert_eq!(result.column_members, vec![Vec::<Value>::new()]);
        assert_eq!(result.cells, vec![Some(2.0), Some(1.0), Some(1.0)]);
        assert_eq!(result.cell_count, 3);
    }

    #[test]
    fn tabulate_supports_no_dimensions() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec![],
            vec![],
            vec![
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("count-sales", "sales", StatisticKind::Count),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.row_members, vec![Vec::<Value>::new()]);
        assert_eq!(result.column_members, vec![Vec::<Value>::new()]);
        assert_eq!(result.cells, vec![Some(25.0), Some(4.0)]);
        assert_eq!(result.cell_count, 2);
    }

    #[test]
    fn tabulate_preserves_outer_to_inner_dimension_order() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region", "product"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![
                vec![json!("East"), json!("A")],
                vec![json!("East"), json!("B")],
                vec![json!("West"), json!("A")],
                vec![Value::Null, json!("A")],
            ]
        );
        assert_eq!(result.column_members, vec![Vec::<Value>::new()]);
        assert_eq!(
            result.cells,
            vec![Some(2.0), Some(0.0), Some(1.0), Some(1.0)]
        );
    }

    #[test]
    fn tabulate_allows_exactly_ten_thousand_cells() {
        let engine = make_fixture_engine();
        let mut request = make_request(vec![], vec![], repeated_count_statistics(10_000));
        request.max_result_cells = 10_000;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.cells.len(), 10_000);
        assert_eq!(result.cell_count, 10_000);
        assert_eq!(result.limit, 10_000);
    }

    #[test]
    fn tabulate_rejects_results_above_max_cell_limit() {
        let engine = make_fixture_engine();
        let mut request = make_request(vec![], vec![], repeated_count_statistics(10_001));
        request.max_result_cells = 10_000;

        let error = engine.tabulate(&request).expect_err("cell limit must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("10001 cells") && message.contains("limit is 10000"))
        );
    }

    #[test]
    fn tabulate_rejects_unknown_field_before_sql_preparation() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["unknown_field"],
            vec![],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("unknown field must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("unknown_field"))
        );
    }

    #[test]
    fn tabulate_rejects_non_numeric_field_for_mean() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec![],
            vec![make_statistic("mean-region", "region", StatisticKind::Mean)],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("non-numeric field must fail");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("region") && message.contains("numeric"))
        );
    }

    #[test]
    fn tabulate_rejects_interval_field_for_mean() {
        let engine = make_typed_dimension_fixture_engine();
        let request = make_request(
            vec![],
            vec![],
            vec![make_statistic(
                "mean-duration",
                "duration",
                StatisticKind::Mean,
            )],
        );

        let error = engine
            .tabulate(&request)
            .expect_err("interval must not be treated as numeric");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("duration") && message.contains("numeric"))
        );
    }

    #[test]
    fn tabulate_formats_typed_dimension_members_for_display() {
        let engine = make_typed_dimension_fixture_engine();
        let request = make_request(
            vec!["amount", "event_date", "event_time"],
            vec![],
            vec![make_statistic(
                "count-amount",
                "amount",
                StatisticKind::Count,
            )],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_members,
            vec![vec![
                json!("12.50"),
                json!("2026-08-13"),
                json!("2026-08-13 09:10:11"),
            ]]
        );
        assert_eq!(result.cells, vec![Some(1.0)]);
    }

    #[test]
    fn tabulate_statistics() {
        let engine = make_fixture_engine();
        let mut request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("count-sales", "sales", StatisticKind::Count),
                make_statistic("missing-sales", "sales", StatisticKind::MissingCount),
                make_statistic("unique-sales", "sales", StatisticKind::UniqueCount),
                make_statistic("sum-sales", "sales", StatisticKind::Sum),
                make_statistic("mean-sales", "sales", StatisticKind::Mean),
                make_statistic("minimum-sales", "sales", StatisticKind::Minimum),
                make_statistic("maximum-sales", "sales", StatisticKind::Maximum),
                make_statistic("variance-sales", "sales", StatisticKind::Variance),
                make_statistic("stddev-sales", "sales", StatisticKind::StandardDeviation),
                make_statistic("median-sales", "sales", StatisticKind::Median),
                make_statistic("range-sales", "sales", StatisticKind::Range),
                TabulateStatistic {
                    id: "quantile-0-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(0.0),
                },
                TabulateStatistic {
                    id: "quantile-50-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(0.5),
                },
                TabulateStatistic {
                    id: "quantile-100-sales".to_string(),
                    field: "sales".to_string(),
                    kind: StatisticKind::Quantile,
                    quantile: Some(1.0),
                },
                make_statistic("row-pct-sales", "sales", StatisticKind::RowPercentage),
                make_statistic("column-pct-sales", "sales", StatisticKind::ColumnPercentage),
                make_statistic("total-pct-sales", "sales", StatisticKind::TotalPercentage),
            ],
        );
        request.include_row_totals = true;
        request.include_column_totals = true;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(cell_value(&result, 0, 0, "count-sales"), Some(2.0));
        assert_eq!(cell_value(&result, 0, 1, "missing-sales"), Some(1.0));
        assert_eq!(cell_value(&result, 0, 0, "unique-sales"), Some(2.0));
        assert_option_close(cell_value(&result, 0, 0, "sum-sales"), 30.0);
        assert_option_close(cell_value(&result, 0, 0, "mean-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "minimum-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "maximum-sales"), 20.0);
        assert_option_close(cell_value(&result, 0, 0, "variance-sales"), 50.0);
        assert_option_close(cell_value(&result, 0, 0, "stddev-sales"), 50.0_f64.sqrt());
        assert_option_close(cell_value(&result, 0, 0, "median-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "range-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-0-sales"), 10.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-50-sales"), 15.0);
        assert_option_close(cell_value(&result, 0, 0, "quantile-100-sales"), 20.0);
        assert_option_close(cell_value(&result, 0, 0, "row-pct-sales"), 1.0);
        assert_option_close(cell_value(&result, 0, 0, "column-pct-sales"), 0.5);
        assert_option_close(cell_value(&result, 0, 0, "total-pct-sales"), 0.5);
        assert_eq!(cell_value(&result, 0, 1, "column-pct-sales"), None);

        assert_option_close(row_total_value(&result, 0, "row-pct-sales"), 1.0);
        assert_option_close(row_total_value(&result, 0, "column-pct-sales"), 0.5);
        assert_option_close(row_total_value(&result, 0, "total-pct-sales"), 0.5);
        assert_option_close(column_total_value(&result, 0, "row-pct-sales"), 1.0);
        assert_option_close(column_total_value(&result, 0, "column-pct-sales"), 1.0);
        assert_option_close(column_total_value(&result, 0, "total-pct-sales"), 1.0);
        assert_eq!(column_total_value(&result, 1, "row-pct-sales"), Some(0.0));
        assert_eq!(column_total_value(&result, 1, "column-pct-sales"), None);
        assert_eq!(column_total_value(&result, 1, "total-pct-sales"), Some(0.0));
        assert_option_close(grand_total_value(&result, "row-pct-sales"), 1.0);
        assert_option_close(grand_total_value(&result, "column-pct-sales"), 1.0);
        assert_option_close(grand_total_value(&result, "total-pct-sales"), 1.0);
    }

    #[test]
    fn tabulate_percentage_statistics_without_display_totals_still_normalize_cells() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("row-pct-sales", "sales", StatisticKind::RowPercentage),
                make_statistic("column-pct-sales", "sales", StatisticKind::ColumnPercentage),
                make_statistic("total-pct-sales", "sales", StatisticKind::TotalPercentage),
            ],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_option_close(cell_value(&result, 0, 0, "row-pct-sales"), 1.0);
        assert_option_close(cell_value(&result, 0, 1, "row-pct-sales"), 0.0);
        assert_option_close(cell_value(&result, 0, 0, "column-pct-sales"), 0.5);
        assert_eq!(cell_value(&result, 0, 1, "column-pct-sales"), None);
        assert_option_close(cell_value(&result, 0, 0, "total-pct-sales"), 0.5);
        assert_option_close(cell_value(&result, 0, 1, "total-pct-sales"), 0.0);

        assert!(result.row_totals.is_empty());
        assert!(result.column_totals.is_empty());
        assert!(result.grand_totals.is_empty());
    }

    #[test]
    fn tabulate_totals_and_grand_totals_follow_flattened_contract() {
        let engine = make_fixture_engine();
        let mut request = make_request(
            vec!["region"],
            vec!["product"],
            vec![
                make_statistic("count-sales", "sales", StatisticKind::Count),
                make_statistic("missing-sales", "sales", StatisticKind::MissingCount),
            ],
        );
        request.include_row_totals = true;
        request.include_column_totals = true;

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(
            result.row_totals,
            vec![
                Some(2.0),
                Some(1.0),
                Some(1.0),
                Some(0.0),
                Some(1.0),
                Some(0.0)
            ]
        );
        assert_eq!(
            result.column_totals,
            vec![Some(4.0), Some(0.0), Some(0.0), Some(1.0)]
        );
        assert_eq!(result.grand_totals, vec![Some(4.0), Some(1.0)]);
    }

    #[test]
    fn tabulate_returns_empty_shape_for_empty_dataset() {
        let engine = make_empty_fixture_engine();
        let request = make_request(
            vec!["region"],
            vec!["product"],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert!(result.row_members.is_empty());
        assert!(result.column_members.is_empty());
        assert!(result.cells.is_empty());
        assert_eq!(result.cell_count, 0);
    }

    #[test]
    fn tabulate_allows_same_field_in_rows_and_columns_once_each() {
        let engine = make_fixture_engine();
        let request = make_request(
            vec!["product"],
            vec!["product"],
            vec![make_statistic("count-sales", "sales", StatisticKind::Count)],
        );

        let result = engine.tabulate(&request).expect("tabulate result");

        assert_eq!(result.row_members, vec![vec![json!("A")], vec![json!("B")]]);
        assert_eq!(
            result.column_members,
            vec![vec![json!("A")], vec![json!("B")]]
        );
        assert_eq!(
            result.cells,
            vec![Some(4.0), Some(0.0), Some(0.0), Some(0.0)]
        );
        assert_eq!(result.cell_count, 4);
    }
}
