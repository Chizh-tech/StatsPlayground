use std::time::Instant;

use serde::Serialize;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::save::SaveProjectRequest;
use crate::services::project_service::{seed_save_project, ProjectService};
use crate::services::spprj_archive;
use crate::services::streaming_project_writer;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Query,
    Paste,
    Restore,
    Save,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    max_retained_batch_bytes: Option<u64>,
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
                    "save" | "save_current" => Operation::Save,
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
    if options.operation == Operation::Save {
        return execute_save(options);
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
        Operation::Save => unreachable!("save is handled before this branch"),
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
        max_retained_batch_bytes: None,
    })
}

fn execute_save(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    let setup_started = Instant::now();
    let state = AppState::new()?;
    let archive_path = seed_save_project(&state, options.rows, options.columns)?;
    let setup_ms = setup_started.elapsed().as_millis();

    let history = vec![serde_json::json!({
        "kind": "benchmark",
        "label": "save",
    })];
    let snapshots = vec![serde_json::json!({
        "id": "snapshot-bench-1",
        "datasetId": "save-current-baseline",
        "rows": [1],
    })];
    let graph_builders = vec![serde_json::json!({
        "id": "graph-bench-1",
        "name": "Benchmark Graph",
        "graphType": "line",
        "xField": "col_1",
        "yField": "col_2",
    })];
    let tabulates = vec![serde_json::json!({
        "id": "tab-bench-1",
        "name": "Benchmark Tabulate",
        "sourceDatasetId": "save-current-baseline",
        "rowFields": ["col_1"],
        "columnFields": [],
        "statistics": ["count"]
    })];
    let folders = vec!["Bench".to_string(), "Bench/Sub".to_string()];
    let table_folders = std::collections::HashMap::from([(
        "save-current-baseline".to_string(),
        "Bench/Sub".to_string(),
    )]);
    let graph_folders = std::collections::HashMap::from([(
        "graph-bench-1".to_string(),
        "Bench".to_string(),
    )]);
    let tabulate_folders = std::collections::HashMap::from([(
        "tab-bench-1".to_string(),
        "Bench/Sub".to_string(),
    )]);

    streaming_project_writer::reset_perf_metrics();

    let operation_started = Instant::now();
    let save_result = ProjectService::new(&state).save_project(
        SaveProjectRequest {
            file_path: None,
            history,
            snapshots,
            graph_builders,
            tabulates,
            folders,
            table_folders,
            graph_folders,
            tabulate_folders,
        },
        None,
    );
    let operation_ms = operation_started.elapsed().as_millis();
    let save_perf_metrics = streaming_project_writer::current_perf_metrics();

    let save_metrics_result = match save_result {
        Ok(_) => {
            let archive_bytes = std::fs::metadata(&archive_path)
                .map(|metadata| metadata.len())
                .map_err(AppError::from)?;
            let reopened = spprj_archive::read_project_file(&archive_path)?;
            let result_rows = reopened.tables.iter().map(|table| table.rows.len()).sum();
            Ok((archive_bytes, result_rows))
        }
        Err(error) => Err(error),
    };

    remove_benchmark_artifacts(&archive_path);
    let (archive_bytes, result_rows) = save_metrics_result?;

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows,
        archive_bytes,
        max_retained_batch_bytes: Some(save_perf_metrics.max_retained_batch_bytes as u64),
    })
}

fn remove_benchmark_artifacts(archive_path: &str) {
    let path = std::path::Path::new(archive_path);
    let temp_dir = std::env::temp_dir();
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if parent != temp_dir {
        return;
    }
    if !file_name.starts_with("stats_playground_save_current_") || !file_name.ends_with(".spprj") {
        return;
    }

    let _ = std::fs::remove_file(path);

    let tmp_candidate = format!("{}.tmp", archive_path);
    let tmp_path = std::path::Path::new(&tmp_candidate);
    if tmp_path.is_dir() {
        let _ = std::fs::remove_dir_all(tmp_path);
    } else {
        let _ = std::fs::remove_file(tmp_path);
    }
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

    fn owned_archive_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "stats_playground_save_current_{}.spprj",
            uuid::Uuid::new_v4()
        ))
    }

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
            Operation::Save,
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
            if operation == Operation::Save {
                assert!(report.archive_bytes > 0);
                assert!(report.max_retained_batch_bytes.is_some());
                assert!(json.get("maxRetainedBatchBytes").is_some());
            } else {
                assert!(report.max_retained_batch_bytes.is_none());
                assert!(json.get("maxRetainedBatchBytes").is_none());
            }
        }
    }

    #[test]
    fn performance_cli_accepts_legacy_save_current_alias() {
        let options = parse_args([
            "--rows",
            "100",
            "--columns",
            "4",
            "--operation",
            "save_current",
        ]
        .map(String::from))
        .unwrap();

        assert_eq!(options.operation, Operation::Save);
    }

    #[test]
    fn performance_cli_measures_current_project_save() {
        let report = execute(Options {
            rows: 300_000,
            columns: 20,
            operation: Operation::Save,
        })
        .unwrap();

        assert_eq!(report.result_rows, 300_000);
        assert!(report.archive_bytes > 0);
    }

    #[test]
    fn cleanup_removes_owned_archive_and_tmp_directory() {
        let archive_path = owned_archive_path();
        std::fs::write(&archive_path, b"archive").unwrap();
        let tmp_path = std::path::PathBuf::from(format!("{}.tmp", archive_path.to_string_lossy()));
        std::fs::create_dir_all(&tmp_path).unwrap();

        remove_benchmark_artifacts(archive_path.to_str().unwrap());

        assert!(!archive_path.exists());
        assert!(!tmp_path.exists());
    }

    #[test]
    fn cleanup_does_not_touch_non_owned_paths() {
        let temp_dir = std::env::temp_dir();
        let non_owned = temp_dir.join(format!("do_not_touch_{}.spprj", uuid::Uuid::new_v4()));
        std::fs::write(&non_owned, b"keep").unwrap();
        let non_owned_tmp = std::path::PathBuf::from(format!("{}.tmp", non_owned.to_string_lossy()));
        std::fs::write(&non_owned_tmp, b"keep-tmp").unwrap();

        remove_benchmark_artifacts(non_owned.to_str().unwrap());

        assert!(non_owned.exists());
        assert!(non_owned_tmp.exists());

        let _ = std::fs::remove_file(non_owned);
        let _ = std::fs::remove_file(non_owned_tmp);
    }
}