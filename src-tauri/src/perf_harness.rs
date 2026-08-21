use std::time::Instant;

use serde::Serialize;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::services::project_service::{seed_save_project, ProjectService};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Query,
    Paste,
    Restore,
    SaveCurrent,
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    rows: usize,
    columns: usize,
    operation: Operation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceReport {
    rows: usize,
    columns: usize,
    operation: Operation,
    setup_ms: u128,
    operation_ms: u128,
    total_ms: u128,
    result_rows: usize,
    archive_bytes: u64,
}

fn parse_positive_usize(flag: &str, value: Option<String>) -> Result<usize, AppError> {
    let value = value.ok_or_else(|| AppError::InvalidParam(format!("missing value for {flag}")))?;
    let parsed = value
        .parse::<usize>()
        .map_err(|_| AppError::InvalidParam(format!("invalid value for {flag}: {value}")))?;
    if parsed == 0 {
        return Err(AppError::InvalidParam(format!("{flag} must be at least 1")));
    }
    Ok(parsed)
}

fn parse_args<I>(args: I) -> Result<Options, AppError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = Options {
        rows: 100_000,
        columns: 20,
        operation: Operation::Query,
    };
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--rows" => options.rows = parse_positive_usize(&flag, args.next())?,
            "--columns" => options.columns = parse_positive_usize(&flag, args.next())?,
            "--operation" => {
                let value = args.next().ok_or_else(|| {
                    AppError::InvalidParam("missing value for --operation".into())
                })?;
                options.operation = match value.as_str() {
                    "query" => Operation::Query,
                    "paste" => Operation::Paste,
                    "restore" => Operation::Restore,
                    "save_current" => Operation::SaveCurrent,
                    _ => {
                        return Err(AppError::InvalidParam(format!(
                            "unknown operation: {value}"
                        )))
                    }
                };
            }
            _ => return Err(AppError::InvalidParam(format!("unknown argument: {flag}"))),
        }
    }
    Ok(options)
}

fn execute(options: Options) -> Result<PerformanceReport, AppError> {
    if options.operation == Operation::SaveCurrent {
        return execute_save_current(options);
    }

    let total_started = Instant::now();
    let setup_started = Instant::now();
    let db = DuckDbEngine::new_in_memory()?;
    db.seed_benchmark_table(
        "performance-baseline",
        "Performance Baseline",
        options.rows,
        options.columns,
    )?;
    let setup_ms = setup_started.elapsed().as_millis();

    let operation_started = Instant::now();
    let result_rows = match options.operation {
        Operation::Query => db
            .query_table("performance-baseline", 0, 500, None, None)?
            .rows
            .len(),
        Operation::Paste => {
            let paste_columns = options.columns.min(10);
            let rows = (0..options.rows)
                .map(|row| {
                    (0..paste_columns)
                        .map(|column| (row + column).to_string())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            db.paste_at_position(
                "performance-baseline",
                0,
                0,
                &rows,
                None,
                &vec!["BIGINT".to_string(); paste_columns],
            )?;
            rows.len()
        }
        Operation::Restore => {
            let snapshot = db.query_table(
                "performance-baseline",
                0,
                options.rows,
                None,
                None,
            )?;
            db.restore_snapshot(
                "performance-baseline",
                &snapshot.columns[1..],
                &snapshot.column_types[1..],
                &snapshot.rows,
            )?;
            snapshot.rows.len()
        }
        Operation::SaveCurrent => unreachable!("save_current is handled before this branch"),
    };
    let operation_ms = operation_started.elapsed().as_millis();

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows,
        archive_bytes: 0,
    })
}

fn execute_save_current(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    let setup_started = Instant::now();
    let state = AppState::new()?;
    let archive_path = seed_save_project(&state, options.rows, options.columns)?;
    let setup_ms = setup_started.elapsed().as_millis();

    let operation_started = Instant::now();
    let save_result = ProjectService::new(&state).save_project(
        None,
        Some(Vec::new()),
        Some(Vec::new()),
        Some(Vec::new()),
        Some(Vec::new()),
        Some(Vec::new()),
        Some(std::collections::HashMap::new()),
        Some(std::collections::HashMap::new()),
        Some(std::collections::HashMap::new()),
    );
    let operation_ms = operation_started.elapsed().as_millis();

    let archive_bytes_result = match save_result {
        Ok(()) => std::fs::metadata(&archive_path)
            .map(|metadata| metadata.len())
            .map_err(AppError::from),
        Err(error) => Err(error),
    };

    let _ = std::fs::remove_file(&archive_path);
    let _ = std::fs::remove_file(format!("{}.tmp", archive_path));
    let archive_bytes = archive_bytes_result?;

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows: options.rows,
        archive_bytes,
    })
}

pub fn run_cli() -> Result<(), String> {
    let options = parse_args(std::env::args().skip(1)).map_err(|error| error.to_string())?;
    let report = execute(options).map_err(|error| error.to_string())?;
    let json = serde_json::to_string(&report).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn performance_cli_uses_reference_defaults() {
        let options = parse_args(Vec::<String>::new()).unwrap();

        assert_eq!(options.rows, 100_000);
        assert_eq!(options.columns, 20);
        assert_eq!(options.operation, Operation::Query);
    }

    #[test]
    fn performance_cli_rejects_unknown_operation() {
        let error = parse_args(["--operation", "unknown"].map(String::from)).unwrap_err();

        assert!(matches!(error, crate::error::AppError::InvalidParam(_)));
    }

    #[test]
    fn performance_cli_executes_each_operation() {
        for operation in [
            Operation::Query,
            Operation::Paste,
            Operation::Restore,
            Operation::SaveCurrent,
        ] {
            let report = execute(Options {
                rows: 25,
                columns: 4,
                operation,
            })
            .unwrap();

            assert_eq!(report.rows, 25);
            assert_eq!(report.columns, 4);
            assert_eq!(report.operation, operation);
            assert_eq!(report.result_rows, 25);

            let json = serde_json::to_value(&report).unwrap();
            assert!(json.get("setupMs").is_some());
            assert!(json.get("operationMs").is_some());
            assert!(json.get("totalMs").is_some());
            assert!(json.get("archiveBytes").is_some());
            if operation == Operation::SaveCurrent {
                assert!(report.archive_bytes > 0);
            }
        }
    }

    #[test]
    fn performance_cli_measures_current_project_save() {
        let report = execute(Options {
            rows: 300_000,
            columns: 20,
            operation: Operation::SaveCurrent,
        })
        .unwrap();

        assert_eq!(report.result_rows, 300_000);
        assert!(report.archive_bytes > 0);
    }
}