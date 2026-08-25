use std::io::Write;

use duckdb::types::Value as DuckValue;

use crate::error::AppError;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(test)]
static ARCHIVE_CELL_TO_JSON_CALLS: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveCellWriteMode {
    Scalar,
    BlobTagged,
    Tagged,
}

#[cfg(test)]
pub(crate) fn reset_archive_cell_to_json_call_count() {
    ARCHIVE_CELL_TO_JSON_CALLS.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn archive_cell_to_json_call_count() -> usize {
    ARCHIVE_CELL_TO_JSON_CALLS.load(Ordering::SeqCst)
}

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

pub(crate) fn archive_cell_write_mode(column_type: &str) -> ArchiveCellWriteMode {
    if is_archive_scalar_type(column_type) {
        ArchiveCellWriteMode::Scalar
    } else if column_type.trim().eq_ignore_ascii_case("BLOB") {
        ArchiveCellWriteMode::BlobTagged
    } else {
        ArchiveCellWriteMode::Tagged
    }
}

pub(crate) fn write_archive_cell_with_mode<W: Write>(
    writer: &mut W,
    value: &DuckValue,
    mode: ArchiveCellWriteMode,
) -> Result<(), AppError> {
    match mode {
        ArchiveCellWriteMode::Scalar => write_scalar_archive_cell(writer, value),
        ArchiveCellWriteMode::BlobTagged => write_blob_tagged_archive_cell(writer, value),
        ArchiveCellWriteMode::Tagged => {
            if let DuckValue::Blob(bytes) = value {
                write_tagged_blob(writer, bytes)
            } else {
                let json = tagged_value_to_json(value, "")?;
                serde_json::to_writer(writer, &json)
                    .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
            }
        }
    }
}

fn write_blob_tagged_archive_cell<W: Write>(
    writer: &mut W,
    value: &DuckValue,
) -> Result<(), AppError> {
    match value {
        DuckValue::Null => writer
            .write_all(b"null")
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::Blob(bytes) => write_tagged_blob(writer, bytes),
        DuckValue::Text(text) => write_tagged_text(writer, text),
        other => {
            let json = serde_json::json!({ "$duckdbValue": format!("{:?}", other) });
            serde_json::to_writer(writer, &json)
                .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
        }
    }
}

fn write_tagged_text<W: Write>(writer: &mut W, text: &str) -> Result<(), AppError> {
    writer
        .write_all(b"{\"$duckdbValue\":")
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))?;
    serde_json::to_writer(&mut *writer, text)
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))?;
    writer
        .write_all(b"}")
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
}

fn write_tagged_blob<W: Write>(writer: &mut W, bytes: &[u8]) -> Result<(), AppError> {
    writer
        .write_all(b"{\"$duckdbValue\":\"")
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))?;
    write_upper_hex_bytes(writer, bytes)?;
    writer
        .write_all(b"\"}")
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
}

fn write_upper_hex_bytes<W: Write>(writer: &mut W, bytes: &[u8]) -> Result<(), AppError> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = Vec::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize]);
        encoded.push(HEX[(byte & 0x0F) as usize]);
    }
    writer
        .write_all(&encoded)
        .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
}

pub(crate) fn write_archive_cell<W: Write>(
    writer: &mut W,
    value: &DuckValue,
    column_type: &str,
) -> Result<(), AppError> {
    write_archive_cell_with_mode(writer, value, archive_cell_write_mode(column_type))
}

fn write_scalar_archive_cell<W: Write>(writer: &mut W, value: &DuckValue) -> Result<(), AppError> {
    match value {
        DuckValue::Null => writer
            .write_all(b"null")
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::Boolean(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::TinyInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::SmallInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::Int(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::BigInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::UTinyInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::USmallInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::UInt(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::UBigInt(value) => serde_json::to_writer(writer, &value.to_string())
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        DuckValue::Float(value) => {
            let finite = f64::from(*value);
            if !finite.is_finite() {
                return Err(AppError::InvalidParam(format!(
                    "non-finite float cannot be archived as JSON number: {finite}"
                )));
            }
            serde_json::to_writer(writer, value)
                .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
        }
        DuckValue::Double(value) => {
            if !value.is_finite() {
                return Err(AppError::InvalidParam(format!(
                    "non-finite float cannot be archived as JSON number: {value}"
                )));
            }
            serde_json::to_writer(writer, value)
                .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}")))
        }
        DuckValue::Text(value) => serde_json::to_writer(writer, value)
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
        other => serde_json::to_writer(writer, &format!("{:?}", other))
            .map_err(|e| AppError::FileIO(format!("failed to serialize archive cell: {e}"))),
    }
}

pub(crate) fn archive_cell_to_json(
    value: &DuckValue,
    column_type: &str,
) -> Result<serde_json::Value, AppError> {
    #[cfg(test)]
    {
        ARCHIVE_CELL_TO_JSON_CALLS.fetch_add(1, Ordering::SeqCst);
    }

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

fn tagged_value_to_json(
    value: &DuckValue,
    column_type: &str,
) -> Result<serde_json::Value, AppError> {
    match value {
        DuckValue::Null => Ok(serde_json::Value::Null),
        DuckValue::Text(text) => Ok(serde_json::json!({ "$duckdbValue": text })),
        DuckValue::UTinyInt(value) => Ok(serde_json::json!({ "$duckdbValue": value.to_string() })),
        DuckValue::USmallInt(value) => Ok(serde_json::json!({ "$duckdbValue": value.to_string() })),
        DuckValue::UInt(value) => Ok(serde_json::json!({ "$duckdbValue": value.to_string() })),
        DuckValue::UBigInt(value) => Ok(serde_json::json!({ "$duckdbValue": value.to_string() })),
        DuckValue::Blob(bytes) if column_type.trim().eq_ignore_ascii_case("BLOB") => {
            Ok(serde_json::json!({ "$duckdbValue": bytes_to_upper_hex(bytes) }))
        }
        other => Ok(serde_json::json!({ "$duckdbValue": format!("{:?}", other) })),
    }
}

fn bytes_to_upper_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0F) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind, Write};

    use duckdb::types::Value as DuckValue;
    use serde_json::json;

    use crate::error::AppError;
    use crate::services::project_service::ProjectService;
    use crate::services::spprj_archive;
    use crate::state::AppState;

    use super::{archive_cell_to_json, write_archive_cell};

    struct FailingSink {
        bytes: Vec<u8>,
        fail_after: usize,
    }

    impl FailingSink {
        fn new(fail_after: usize) -> Self {
            Self {
                bytes: Vec::new(),
                fail_after,
            }
        }
    }

    impl Write for FailingSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.bytes.len() >= self.fail_after {
                return Err(Error::new(ErrorKind::BrokenPipe, "sink-fail"));
            }
            let remaining = self.fail_after - self.bytes.len();
            let take = remaining.min(buf.len());
            self.bytes.extend_from_slice(&buf[..take]);
            if take < buf.len() {
                return Err(Error::new(ErrorKind::BrokenPipe, "sink-fail"));
            }
            Ok(take)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn golden_scalar_and_tagged_cases_are_independent_of_compose() {
        let cases: Vec<(&str, DuckValue, &str, serde_json::Value, Option<&[u8]>)> = vec![
            (
                "null",
                DuckValue::Null,
                "INTEGER",
                serde_json::Value::Null,
                Some(b"null"),
            ),
            (
                "bool",
                DuckValue::Boolean(true),
                "BOOLEAN",
                json!(true),
                Some(b"true"),
            ),
            (
                "i64",
                DuckValue::BigInt(-42),
                "BIGINT",
                json!(-42),
                Some(b"-42"),
            ),
            (
                "u64-over-i64",
                DuckValue::Text("9223372036854775808".to_string()),
                "UBIGINT",
                json!({"$duckdbValue": "9223372036854775808"}),
                Some(br#"{"$duckdbValue":"9223372036854775808"}"#),
            ),
            (
                "u64-max",
                DuckValue::Text("18446744073709551615".to_string()),
                "UBIGINT",
                json!({"$duckdbValue": "18446744073709551615"}),
                Some(br#"{"$duckdbValue":"18446744073709551615"}"#),
            ),
            (
                "double-neg-zero",
                DuckValue::Double(-0.0),
                "DOUBLE",
                json!(-0.0),
                Some(b"-0.0"),
            ),
            (
                "text-escaping",
                DuckValue::Text("line1\n\"quoted\"\\slash".to_string()),
                "VARCHAR",
                json!("line1\n\"quoted\"\\slash"),
                Some(br#""line1\n\"quoted\"\\slash""#),
            ),
            (
                "blob-hex-uppercase",
                DuckValue::Blob(vec![0x00, 0xff, 0x7a]),
                "BLOB",
                json!({"$duckdbValue": "00FF7A"}),
                Some(br#"{"$duckdbValue":"00FF7A"}"#),
            ),
            (
                "decimal-tag",
                DuckValue::Text("-12.3400".to_string()),
                "DECIMAL(10,4)",
                json!({"$duckdbValue": "-12.3400"}),
                Some(br#"{"$duckdbValue":"-12.3400"}"#),
            ),
            (
                "date-tag",
                DuckValue::Text("2026-08-20".to_string()),
                "DATE",
                json!({"$duckdbValue": "2026-08-20"}),
                Some(br#"{"$duckdbValue":"2026-08-20"}"#),
            ),
            (
                "time-tag",
                DuckValue::Text("10:11:12.345678".to_string()),
                "TIME",
                json!({"$duckdbValue": "10:11:12.345678"}),
                Some(br#"{"$duckdbValue":"10:11:12.345678"}"#),
            ),
            (
                "timestamp-tag",
                DuckValue::Text("2026-08-20 10:11:12.123456".to_string()),
                "TIMESTAMP",
                json!({"$duckdbValue": "2026-08-20 10:11:12.123456"}),
                Some(br#"{"$duckdbValue":"2026-08-20 10:11:12.123456"}"#),
            ),
            (
                "timestamptz-tag",
                DuckValue::Text("2026-08-20 10:11:12.123456+00".to_string()),
                "TIMESTAMPTZ",
                json!({"$duckdbValue": "2026-08-20 10:11:12.123456+00"}),
                None,
            ),
            (
                "list-tag",
                DuckValue::Text("[1, 2, 3]".to_string()),
                "INTEGER[]",
                json!({"$duckdbValue": "[1, 2, 3]"}),
                Some(br#"{"$duckdbValue":"[1, 2, 3]"}"#),
            ),
            (
                "array-tag",
                DuckValue::Text("[4, 5, 6]".to_string()),
                "INTEGER[3]",
                json!({"$duckdbValue": "[4, 5, 6]"}),
                Some(br#"{"$duckdbValue":"[4, 5, 6]"}"#),
            ),
            (
                "map-tag",
                DuckValue::Text("{\"k\\\"1\": 10, \"k2\": 20}".to_string()),
                "MAP(VARCHAR, INTEGER)",
                json!({"$duckdbValue": "{\"k\\\"1\": 10, \"k2\": 20}"}),
                None,
            ),
            (
                "struct-tag",
                DuckValue::Text("{'label': a\"b\\c, 'score': 7}".to_string()),
                "STRUCT(label VARCHAR, score INTEGER)",
                json!({"$duckdbValue": "{'label': a\"b\\c, 'score': 7}"}),
                None,
            ),
            (
                "nested-struct-tag",
                DuckValue::Text("{'outer': {'inner': [1, 2], 'label': x\"y\\z}}".to_string()),
                "STRUCT(outer STRUCT(inner INTEGER[], label VARCHAR))",
                json!({"$duckdbValue": "{'outer': {'inner': [1, 2], 'label': x\"y\\z}}"}),
                None,
            ),
            (
                "union-tag",
                DuckValue::Text("union_value(num := 7)".to_string()),
                "UNION(num INTEGER)",
                json!({"$duckdbValue": "union_value(num := 7)"}),
                Some(br#"{"$duckdbValue":"union_value(num := 7)"}"#),
            ),
            (
                "uuid-tag",
                DuckValue::Text("550e8400-e29b-41d4-a716-446655440000".to_string()),
                "UUID",
                json!({"$duckdbValue": "550e8400-e29b-41d4-a716-446655440000"}),
                Some(br#"{"$duckdbValue":"550e8400-e29b-41d4-a716-446655440000"}"#),
            ),
            (
                "enum-tag",
                DuckValue::Text("re\"d\\x".to_string()),
                "ENUM('red', 're\"d\\x')",
                json!({"$duckdbValue": "re\"d\\x"}),
                Some(br#"{"$duckdbValue":"re\"d\\x"}"#),
            ),
        ];

        for (name, value, column_type, expected, expected_bytes) in cases {
            let actual = archive_cell_to_json(&value, column_type).unwrap();
            assert_eq!(actual, expected, "case {name}");

            let mut bytes = Vec::new();
            write_archive_cell(&mut bytes, &value, column_type).unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed, expected, "case {name} writer parse");

            if let Some(expected_bytes) = expected_bytes {
                assert_eq!(bytes.as_slice(), expected_bytes, "case {name} writer bytes");
            }
        }
    }

    #[test]
    fn direct_writer_unsigned_duckvalues_use_plain_decimal_tagged_strings() {
        let cases: Vec<(&str, DuckValue, &str, &str)> = vec![
            (
                "utinyint-max",
                DuckValue::UTinyInt(u8::MAX),
                "UTINYINT",
                "255",
            ),
            (
                "usmallint-max",
                DuckValue::USmallInt(u16::MAX),
                "USMALLINT",
                "65535",
            ),
            (
                "uinteger-max",
                DuckValue::UInt(u32::MAX),
                "UINTEGER",
                "4294967295",
            ),
            (
                "ubigint-over-i64-max",
                DuckValue::UBigInt(i64::MAX as u64 + 1),
                "UBIGINT",
                "9223372036854775808",
            ),
            (
                "ubigint-u64-max",
                DuckValue::UBigInt(u64::MAX),
                "UBIGINT",
                "18446744073709551615",
            ),
        ];

        for (name, value, column_type, expected_decimal) in cases {
            let expected = json!({"$duckdbValue": expected_decimal});
            let actual = archive_cell_to_json(&value, column_type).unwrap();
            assert_eq!(actual, expected, "case {name} json");

            let mut bytes = Vec::new();
            write_archive_cell(&mut bytes, &value, column_type).unwrap();
            assert_eq!(
                bytes,
                format!("{{\"$duckdbValue\":\"{expected_decimal}\"}}").into_bytes(),
                "case {name} writer bytes"
            );
        }
    }

    #[test]
    fn edge_matrix_uses_real_duckdb_values() {
        let source = include_str!("archive_cell.rs");
        assert!(
            !source
                .contains("unwrap_or_else(|| json!({\"$duckdbValue\": format!(\"{:?}\", value)}))"),
            "expected values in this test must be fixed literals without runtime debug fallback"
        );

        let state = AppState::new().unwrap();
        let db = state.db.lock().unwrap();
        let query = r#"
            SELECT
                9223372036854775808::UBIGINT AS ubig_over_i64,
                18446744073709551615::UBIGINT AS ubig_max,
                CAST('-0.0' AS DOUBLE) AS neg_zero,
                concat('line1', chr(10), '"quoted"', '\\slash') AS escaped_text,
                hex(from_hex('00ff7a')) AS blob_hex,
                -12.3400::DECIMAL(10,4) AS dec_value,
                DATE '2026-08-20' AS d,
                TIME '10:11:12.345678' AS t,
                TIMESTAMP '2026-08-20 10:11:12.123456' AS ts,
                TIMESTAMPTZ '2026-08-20 10:11:12.123456+00' AS tstz,
                [1, 2, 3]::INTEGER[] AS l,
                [4, 5, 6]::INTEGER[3] AS a,
                MAP(['k"1', 'k2'], [10, 20]) AS m,
                struct_pack(label := 'a"b\\c', score := 7) AS s,
                union_value(num := 7) AS u,
                '550e8400-e29b-41d4-a716-446655440000'::UUID AS uid,
                're"d\\x'::ENUM('red', 're"d\\x') AS e
        "#;
        let mut stmt = db.conn().prepare(query).unwrap();
        let mut rows = stmt.query([]).unwrap();
        let row = rows.next().unwrap().unwrap();

        let cases: Vec<(&str, usize, &str, serde_json::Value)> = vec![
            (
                "ubig_over_i64",
                0,
                "UBIGINT",
                json!({"$duckdbValue": "9223372036854775808"}),
            ),
            (
                "ubig_max",
                1,
                "UBIGINT",
                json!({"$duckdbValue": "18446744073709551615"}),
            ),
            ("neg_zero", 2, "DOUBLE", json!(-0.0)),
            (
                "escaped_text",
                3,
                "VARCHAR",
                json!("line1\n\"quoted\"\\\\slash"),
            ),
            ("blob_hex", 4, "BLOB", json!({"$duckdbValue": "00FF7A"})),
            (
                "dec_value",
                5,
                "DECIMAL(10,4)",
                json!({"$duckdbValue": "Decimal(Decimal { width: 10, scale: 4, value: -123400 })"}),
            ),
            ("date", 6, "DATE", json!({"$duckdbValue": "Date32(20685)"})),
            (
                "time",
                7,
                "TIME",
                json!({"$duckdbValue": "Time64(Microsecond, 36672345678)"}),
            ),
            (
                "timestamp",
                8,
                "TIMESTAMP",
                json!({"$duckdbValue": "Timestamp(Microsecond, 1787220672123456)"}),
            ),
            (
                "timestamptz",
                9,
                "TIMESTAMPTZ",
                json!({"$duckdbValue": "Timestamp(Microsecond, 1787220672123456)"}),
            ),
            (
                "list",
                10,
                "INTEGER[]",
                json!({"$duckdbValue": "List([Int(1), Int(2), Int(3)])"}),
            ),
            (
                "array",
                11,
                "INTEGER[3]",
                json!({"$duckdbValue": "Array([Int(4), Int(5), Int(6)])"}),
            ),
            (
                "map",
                12,
                "MAP(VARCHAR, INTEGER)",
                json!({"$duckdbValue": r#"Map(OrderedMap([(Text("k\"1"), Int(10)), (Text("k2"), Int(20))]))"#}),
            ),
            (
                "struct",
                13,
                "STRUCT(label VARCHAR, score INTEGER)",
                json!({"$duckdbValue": r#"Struct(OrderedMap([("label", Text("a\"b\\\\c")), ("score", Int(7))]))"#}),
            ),
            (
                "union",
                14,
                "UNION(num INTEGER)",
                json!({"$duckdbValue": "Union(Int(7))"}),
            ),
            (
                "uuid",
                15,
                "UUID",
                json!({"$duckdbValue": "550e8400-e29b-41d4-a716-446655440000"}),
            ),
            (
                "enum",
                16,
                "ENUM('red', 're\"d\\x')",
                json!({"$duckdbValue": "Enum(\"re\\\"d\\\\\\\\x\")"}),
            ),
        ];

        for (name, index, column_type, expected) in cases {
            let value: DuckValue = row.get(index).unwrap();
            let actual = archive_cell_to_json(&value, column_type).unwrap();
            assert_eq!(actual, expected, "edge case {name}");
        }
    }

    #[test]
    fn non_finite_floats_are_invalid_param() {
        for (name, value) in [
            ("nan", DuckValue::Double(f64::NAN)),
            ("inf", DuckValue::Double(f64::INFINITY)),
            ("neg_inf", DuckValue::Double(f64::NEG_INFINITY)),
        ] {
            let error = archive_cell_to_json(&value, "DOUBLE").unwrap_err();
            assert!(
                matches!(&error, AppError::InvalidParam(message) if message.contains("non-finite float")),
                "expected InvalidParam for {name}, got {error:?}"
            );
        }
    }

    #[test]
    fn writer_sink_failures_map_to_fileio_and_allow_partial_bytes() {
        let mut sink = FailingSink::new(3);
        let error = write_archive_cell(&mut sink, &DuckValue::Text("hello".to_string()), "VARCHAR")
            .unwrap_err();

        assert!(
            matches!(&error, AppError::FileIO(message) if message.contains("failed to serialize archive cell")),
            "expected FileIO sink error, got {error:?}"
        );
        assert!(
            !sink.bytes.is_empty(),
            "sink should receive partial bytes before failure"
        );
        assert!(sink.bytes.len() < br#""hello""#.len());
    }

    #[test]
    fn standalone_export_table_route_matches_shared_cell_encoding_behavior() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_table_from_sql_query(
                "standalone-archive",
                "Standalone Archive",
                "SELECT 1 AS id, 18446744073709551615::UBIGINT AS u64v, CAST('-0.0' AS DOUBLE) AS negz, from_hex('deadbeef') AS blobv, -12.3400::DECIMAL(10,4) AS decv, [1, 2]::INTEGER[] AS listv",
            )
            .unwrap();
        }

        let service = ProjectService::new(&state);
        let expected_doc = service.compose_table_doc("standalone-archive").unwrap();
        let output = std::env::temp_dir().join(format!(
            "stats_playground_export_table_route_{}.sptb",
            uuid::Uuid::new_v4()
        ));

        service
            .export_table("standalone-archive", output.to_str().unwrap())
            .unwrap();
        let written_doc = spprj_archive::read_table_file(output.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(output);

        assert_eq!(written_doc.rows, expected_doc.rows);

        assert_eq!(
            written_doc.rows[0],
            vec![
                json!(1),
                json!(1),
                json!({"$duckdbValue": "18446744073709551615"}),
                json!(-0.0),
                json!({"$duckdbValue": "DEADBEEF"}),
                json!({"$duckdbValue": "-12.3400"}),
                json!({"$duckdbValue": "[1, 2]"}),
            ]
        );
    }

    #[test]
    fn compose_table_doc_preserves_legacy_unsigned_overflow_tagged_shape() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_table_from_sql_query(
                "compose-unsigned-overflow",
                "Compose Unsigned Overflow",
                "SELECT 1 AS id, 9223372036854775808::UBIGINT AS over_i64, 18446744073709551615::UBIGINT AS max_u64, 340282366920938463463374607431768211455::UHUGEINT AS over_u64",
            )
            .unwrap();
        }

        let service = ProjectService::new(&state);
        let doc = service
            .compose_table_doc("compose-unsigned-overflow")
            .unwrap();
        assert_eq!(
            doc.rows[0],
            vec![
                json!(1),
                json!(1),
                json!({"$duckdbValue": "9223372036854775808"}),
                json!({"$duckdbValue": "18446744073709551615"}),
                json!({"$duckdbValue": "340282366920938463463374607431768211455"}),
            ]
        );
    }

    #[test]
    fn compose_table_doc_and_writer_share_the_same_compatibility_path() {
        let state = AppState::new().unwrap();
        {
            let db = state.db.lock().unwrap();
            db.create_table_from_sql_query(
                "compose-shared-path",
                "Compose Shared Path",
                "SELECT 1 AS id, true AS b, from_hex('00ff') AS blobv, [1, 2, 3]::INTEGER[] AS listv",
            )
            .unwrap();
        }

        let service = ProjectService::new(&state);
        let doc = service.compose_table_doc("compose-shared-path").unwrap();
        let row = &doc.rows[0];

        assert_eq!(row[1], json!(1));
        assert_eq!(row[2], json!(true));
        assert_eq!(row[3], json!({"$duckdbValue": "00FF"}));
        assert_eq!(row[4], json!({"$duckdbValue": "[1, 2, 3]"}));
    }
}
