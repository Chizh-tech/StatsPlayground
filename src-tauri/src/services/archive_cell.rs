use std::io::Write;

use duckdb::types::Value as DuckValue;

use crate::error::AppError;

pub(crate) fn is_archive_scalar_type(column_type: &str) -> bool {
    matches!(
        column_type.trim().to_ascii_uppercase().as_str(),
        "BOOLEAN"
            | "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "BIGINT"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "VARCHAR"
    )
}

pub(crate) fn archive_export_expression(column_name: &str, column_type: &str) -> String {
    let identifier = quote_identifier(column_name);
    if is_archive_scalar_type(column_type) {
        identifier
    } else if column_type.trim().eq_ignore_ascii_case("BLOB") {
        format!("hex({identifier})")
    } else {
        format!("CAST({identifier} AS VARCHAR)")
    }
}

pub(crate) fn write_archive_cell<W: Write>(
    writer: &mut W,
    value: &DuckValue,
    column_type: &str,
) -> Result<(), AppError> {
    let json = archive_cell_to_json(value, column_type)?;
    serde_json::to_writer(writer, &json)
        .map_err(|e| AppError::InvalidParam(format!("failed to serialize archive cell: {e}")))
}

pub(crate) fn archive_cell_to_json(
    value: &DuckValue,
    column_type: &str,
) -> Result<serde_json::Value, AppError> {
    if is_archive_scalar_type(column_type) {
        scalar_value_to_json(value)
    } else {
        tagged_value_to_json(value, column_type)
    }
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn scalar_value_to_json(value: &DuckValue) -> Result<serde_json::Value, AppError> {
    match value {
        DuckValue::Null => Ok(serde_json::Value::Null),
        DuckValue::Boolean(value) => Ok(serde_json::Value::Bool(*value)),
        DuckValue::TinyInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::SmallInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::Int(value) => Ok(serde_json::json!(*value)),
        DuckValue::BigInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::UTinyInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::USmallInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::UInt(value) => Ok(serde_json::json!(*value)),
        DuckValue::UBigInt(value) => Ok(serde_json::json!(value.to_string())),
        DuckValue::Float(value) => finite_float_to_json(*value as f64),
        DuckValue::Double(value) => finite_float_to_json(*value),
        DuckValue::Text(value) => Ok(serde_json::Value::String(value.clone())),
        other => Ok(serde_json::Value::String(format!("{:?}", other))),
    }
}

fn finite_float_to_json(value: f64) -> Result<serde_json::Value, AppError> {
    match serde_json::Number::from_f64(value) {
        Some(number) => Ok(serde_json::Value::Number(number)),
        None => Err(AppError::InvalidParam(format!(
            "non-finite float cannot be archived as JSON number: {value}"
        ))),
    }
}

fn tagged_value_to_json(value: &DuckValue, column_type: &str) -> Result<serde_json::Value, AppError> {
    match value {
        DuckValue::Null => Ok(serde_json::Value::Null),
        DuckValue::Text(text) => Ok(serde_json::json!({ "$duckdbValue": text })),
        DuckValue::Blob(bytes) if column_type.trim().eq_ignore_ascii_case("BLOB") => {
            Ok(serde_json::json!({ "$duckdbValue": bytes_to_upper_hex(bytes) }))
        }
        other => Ok(serde_json::json!({ "$duckdbValue": format!("{:?}", other) })),
    }
}

fn bytes_to_upper_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use duckdb::types::Value as DuckValue;

    use crate::services::project_service::ProjectService;
    use crate::state::AppState;

    use super::{archive_export_expression, write_archive_cell};

    #[test]
    fn writer_matches_compose_table_doc_for_supported_archive_types() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            let col_names = vec![
                "c_null".to_string(),
                "c_bool".to_string(),
                "c_i64".to_string(),
                "c_u64".to_string(),
                "c_float".to_string(),
                "c_text".to_string(),
                "c_blob".to_string(),
                "c_decimal".to_string(),
                "c_date".to_string(),
                "c_time".to_string(),
                "c_timestamp".to_string(),
                "c_list".to_string(),
                "c_array".to_string(),
                "c_map".to_string(),
                "c_struct".to_string(),
                "c_union".to_string(),
                "c_uuid".to_string(),
                "c_enum".to_string(),
            ];
            let col_types = vec![
                "INTEGER".to_string(),
                "BOOLEAN".to_string(),
                "BIGINT".to_string(),
                "UBIGINT".to_string(),
                "DOUBLE".to_string(),
                "VARCHAR".to_string(),
                "BLOB".to_string(),
                "DECIMAL(12,2)".to_string(),
                "DATE".to_string(),
                "TIME".to_string(),
                "TIMESTAMP".to_string(),
                "INTEGER[]".to_string(),
                "INTEGER[3]".to_string(),
                "MAP(VARCHAR, INTEGER)".to_string(),
                "STRUCT(label VARCHAR, score INTEGER)".to_string(),
                "UNION(num INTEGER)".to_string(),
                "UUID".to_string(),
                "ENUM('red', 'green')".to_string(),
            ];
            db.create_empty_table(
                "archive-cell-fixture",
                "Archive Cell Fixture",
                &col_names,
                &col_types,
            )
            .unwrap();

            db.conn()
                .execute(
                    r#"INSERT INTO "dataset_archive_cell_fixture" (
                        "_row_id", "c_null", "c_bool", "c_i64", "c_u64", "c_float", "c_text", "c_blob", "c_decimal", "c_date", "c_time", "c_timestamp", "c_list", "c_array", "c_map", "c_struct", "c_union", "c_uuid", "c_enum"
                    )
                    SELECT
                        1,
                        NULL::INTEGER,
                        true,
                        -42::BIGINT,
                        42::UBIGINT,
                        3.25::DOUBLE,
                        concat('line1', chr(10), '"quoted"', '\\slash'),
                        from_hex('deadbeef'),
                        12.34::DECIMAL(12,2),
                        DATE '2026-08-20',
                        TIME '10:11:12',
                        TIMESTAMP '2026-08-20 10:11:12',
                        [1, 2, 3]::INTEGER[],
                        [4, 5, 6]::INTEGER[3],
                        MAP(['k1', 'k2'], [10, 20]),
                        struct_pack(label := 'alpha', score := 7),
                        union_value(num := 7),
                        '550e8400-e29b-41d4-a716-446655440000'::UUID,
                        'red'::ENUM('red', 'green')"#,
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = 1 WHERE id = $1",
                    duckdb::params!["archive-cell-fixture"],
                )
                .unwrap();
        }

        let service = ProjectService::new(&state);
        let doc = service.compose_table_doc("archive-cell-fixture").unwrap();

        let db = state.db.lock().unwrap();
        let table_name = "dataset_archive_cell_fixture";
        let select_cols = std::iter::once("\"_row_id\"".to_string())
            .chain(
                doc.columns
                    .iter()
                    .map(|column| archive_export_expression(&column.name, &column.col_type)),
            )
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT {} FROM \"{}\" ORDER BY \"_row_id\"",
            select_cols, table_name
        );
        let mut stmt = db.conn().prepare(&query).unwrap();
        let mut rows = stmt.query([]).unwrap();
        let row = rows.next().unwrap().unwrap();

        for (column_index, column) in doc.columns.iter().enumerate() {
            let value: DuckValue = row.get(column_index + 1).unwrap();
            let mut json_bytes = Vec::new();
            write_archive_cell(&mut json_bytes, &value, &column.col_type).unwrap();
            let encoded: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
            assert_eq!(encoded, doc.rows[0][column_index + 1], "column {}", column.name);
        }
    }
}