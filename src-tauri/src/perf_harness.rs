use std::time::Instant;

use serde::Serialize;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::save::SaveProjectRequest;
use crate::services::project_service::{seed_save_project, ProjectService};
use crate::services::spprj_archive;
use crate::services::streaming_project_writer::with_save_perf_observer;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    max_encoded_batch_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_combined_batch_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    save_stage_ms: Option<SaveStageReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_memory: Option<ProcessMemoryReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveStageReport {
    plan: u128,
    query_fetch: u128,
    batch_encode: u128,
    zip_write: u128,
    zip_finish: u128,
    sync_all: u128,
    validation: u128,
    replacement: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemoryReport {
    baseline_working_set_bytes: u64,
    peak_working_set_bytes: u64,
    delta_working_set_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut core::ffi::c_void;
}

#[cfg(windows)]
#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCounters,
        counters_size: u32,
    ) -> i32;
}

fn current_working_set_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        let process = unsafe { GetCurrentProcess() };
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let ok = unsafe {
            GetProcessMemoryInfo(
                process,
                &mut counters,
                std::mem::size_of::<ProcessMemoryCounters>() as u32,
            )
        };
        if ok == 0 {
            None
        } else {
            Some(counters.working_set_size as u64)
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn measure_peak_working_set_during<T>(run: impl FnOnce() -> T) -> (T, Option<ProcessMemoryReport>) {
    let Some(baseline) = current_working_set_bytes() else {
        let outcome = run();
        return (outcome, None);
    };

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(baseline));
    let stop_reader = std::sync::Arc::clone(&stop);
    let peak_reader = std::sync::Arc::clone(&peak);
    let sampler = std::thread::spawn(move || {
        while !stop_reader.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(current) = current_working_set_bytes() {
                let mut seen = peak_reader.load(std::sync::atomic::Ordering::Relaxed);
                while current > seen {
                    match peak_reader.compare_exchange_weak(
                        seen,
                        current,
                        std::sync::atomic::Ordering::Relaxed,
                        std::sync::atomic::Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(next_seen) => seen = next_seen,
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if let Some(current) = current_working_set_bytes() {
            let mut seen = peak_reader.load(std::sync::atomic::Ordering::Relaxed);
            while current > seen {
                match peak_reader.compare_exchange_weak(
                    seen,
                    current,
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(next_seen) => seen = next_seen,
                }
            }
        }
    });

    let outcome = run();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = sampler.join();

    let peak_working_set_bytes = peak.load(std::sync::atomic::Ordering::Relaxed);
    let delta_working_set_bytes = peak_working_set_bytes.saturating_sub(baseline);
    (
        outcome,
        Some(ProcessMemoryReport {
            baseline_working_set_bytes: baseline,
            peak_working_set_bytes,
            delta_working_set_bytes,
        }),
    )
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
                    "save" => Operation::Save,
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
            let snapshot = db.query_table("performance-baseline", 0, options.rows, None, None)?;
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
        max_encoded_batch_bytes: None,
        max_combined_batch_bytes: None,
        save_stage_ms: None,
        process_memory: None,
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
    let graph_folders =
        std::collections::HashMap::from([("graph-bench-1".to_string(), "Bench".to_string())]);
    let tabulate_folders =
        std::collections::HashMap::from([("tab-bench-1".to_string(), "Bench/Sub".to_string())]);

    let observed_perf = std::sync::Arc::new(std::sync::Mutex::new(
        crate::models::save::SavePerfMetrics::default(),
    ));
    let observed_perf_capture = std::sync::Arc::clone(&observed_perf);
    let operation_started = Instant::now();
    let (save_result, process_memory) = measure_peak_working_set_during(|| {
        with_save_perf_observer(
            move |metrics| {
                if let Ok(mut slot) = observed_perf_capture.lock() {
                    *slot = metrics;
                }
            },
            || {
                ProjectService::new(&state).save_project(
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
                )
            },
        )
    });
    let operation_ms = operation_started.elapsed().as_millis();
    let observed_perf = observed_perf.lock().map(|slot| *slot).unwrap_or_default();

    let save_metrics_result = match save_result {
        Ok(_) => {
            let archive_bytes = std::fs::metadata(&archive_path)
                .map(|metadata| metadata.len())
                .map_err(AppError::from)?;
            let result_rows = spprj_archive::count_project_rows_streaming(&archive_path)?;
            Ok((archive_bytes, result_rows, observed_perf))
        }
        Err(error) => Err(error),
    };

    remove_benchmark_artifacts(&archive_path);
    let (archive_bytes, result_rows, save_perf_metrics) = save_metrics_result?;

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
        max_encoded_batch_bytes: Some(save_perf_metrics.max_encoded_batch_bytes as u64),
        max_combined_batch_bytes: Some(save_perf_metrics.max_combined_batch_bytes as u64),
        save_stage_ms: Some(SaveStageReport {
            plan: save_perf_metrics.plan_ms,
            query_fetch: save_perf_metrics.query_fetch_ms,
            batch_encode: save_perf_metrics.batch_encode_ms,
            zip_write: save_perf_metrics.zip_write_ms,
            zip_finish: save_perf_metrics.zip_finish_ms,
            sync_all: save_perf_metrics.sync_all_ms,
            validation: save_perf_metrics.validation_ms,
            replacement: save_perf_metrics.replacement_ms,
        }),
        process_memory,
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
                assert!(report.max_encoded_batch_bytes.is_some());
                assert!(report.max_combined_batch_bytes.is_some());
                assert!(report.save_stage_ms.is_some());
                assert!(json.get("maxRetainedBatchBytes").is_some());
                assert!(json.get("maxEncodedBatchBytes").is_some());
                assert!(json.get("maxCombinedBatchBytes").is_some());
                assert!(json.get("saveStageMs").is_some());
            } else {
                assert!(report.max_retained_batch_bytes.is_none());
                assert!(report.max_encoded_batch_bytes.is_none());
                assert!(report.max_combined_batch_bytes.is_none());
                assert!(report.save_stage_ms.is_none());
                assert!(json.get("maxRetainedBatchBytes").is_none());
                assert!(json.get("maxEncodedBatchBytes").is_none());
                assert!(json.get("maxCombinedBatchBytes").is_none());
                assert!(json.get("saveStageMs").is_none());
            }
        }
    }

    #[test]
    fn performance_cli_rejects_legacy_save_current_alias() {
        let error = parse_args(
            [
                "--rows",
                "100",
                "--columns",
                "4",
                "--operation",
                "save_current",
            ]
            .map(String::from),
        )
        .unwrap_err();

        assert!(matches!(error, crate::error::AppError::InvalidParam(_)));
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
        let non_owned_tmp =
            std::path::PathBuf::from(format!("{}.tmp", non_owned.to_string_lossy()));
        std::fs::write(&non_owned_tmp, b"keep-tmp").unwrap();

        remove_benchmark_artifacts(non_owned.to_str().unwrap());

        assert!(non_owned.exists());
        assert!(non_owned_tmp.exists());

        let _ = std::fs::remove_file(non_owned);
        let _ = std::fs::remove_file(non_owned_tmp);
    }
}
