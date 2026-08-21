use std::time::Instant;

use duckdb::params;
use serde::Serialize;

use crate::engine::duckdb_engine::DuckDbEngine;
use crate::error::AppError;
use crate::models::graph_data::{
    GraphChunkHeader, GraphDataCompletion, GraphDataRequest, GraphElementRequest, GraphFieldBinding,
    GraphSampling, GraphViewport,
};
use crate::services::graph_data_service::{GraphDataChunk, GraphDataService};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Query,
    Paste,
    Restore,
    Graph,
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
    selected_columns: usize,
    query_ms: Option<u128>,
    encode_ms: Option<u128>,
    decode_ms: Option<DesktopOnlyMetric>,
    draw_ms: Option<DesktopOnlyMetric>,
    processed_rows: Option<u64>,
    transferred_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopOnlyMetric {
    DesktopOnly,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamHeaderMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    header: &'a GraphChunkHeader,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphStreamCompletionMessage<'a> {
    message_type: &'static str,
    #[serde(flatten)]
    completion: &'a GraphDataCompletion,
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
                    "graph" => Operation::Graph,
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

fn build_graph_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
    GraphDataRequest {
        request_id: format!("request-{dataset_id}"),
        dataset_id: dataset_id.to_string(),
        generation,
        fields: vec![
            GraphFieldBinding {
                role: "x".to_string(),
                column: "region".to_string(),
            },
            GraphFieldBinding {
                role: "y".to_string(),
                column: "cost".to_string(),
            },
        ],
        filters: Vec::new(),
        elements: vec![GraphElementRequest {
            kind: "points".to_string(),
            summary_stat: "none".to_string(),
        }],
        sampling: GraphSampling::Full,
        viewport: GraphViewport {
            width: 1200,
            height: 700,
        },
    }
}

fn seed_graph_benchmark_dataset(state: &AppState, dataset_id: &str, rows: usize) -> Result<(), AppError> {
    let db = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    db.create_empty_table(
        dataset_id,
        "Performance Graph Baseline",
        &["region".into(), "cost".into()],
        &["VARCHAR".into(), "DOUBLE".into()],
    )?;

    if rows > 0 {
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
        let upper_bound = i64::try_from(rows)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| AppError::InvalidParam("benchmark row count is too large".into()))?;
        let insert_sql = format!(
            "INSERT INTO \"{table_name}\" (_row_id, region, cost)
             SELECT i,
                CASE (i % 5)
                    WHEN 1 THEN 'North'
                    WHEN 2 THEN 'South'
                    WHEN 3 THEN 'East'
                    WHEN 4 THEN 'West'
                    ELSE 'Central'
                END,
                CAST(i - 1 AS DOUBLE) * 1.5
             FROM range(1, CAST(? AS BIGINT)) AS generated(i)"
        );
        db.conn().execute(&insert_sql, params![upper_bound])?;
        db.conn().execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            params![rows as i64, dataset_id],
        )?;
    }

    Ok(())
}

fn measure_transferred_bytes(chunks: &[GraphDataChunk], completion: &GraphDataCompletion) -> Result<u64, AppError> {
    let mut transferred = 0u64;
    for chunk in chunks {
        let header_message = GraphStreamHeaderMessage {
            message_type: "header",
            header: &chunk.header,
        };
        let header_bytes = serde_json::to_vec(&header_message)
            .map_err(|error| AppError::InvalidParam(error.to_string()))?;
        transferred = transferred
            .checked_add(u64::try_from(header_bytes.len()).map_err(|_| {
                AppError::InvalidParam("header payload length overflow".to_string())
            })?)
            .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
        transferred = transferred
            .checked_add(u64::try_from(chunk.payload.len()).map_err(|_| {
                AppError::InvalidParam("graph payload length overflow".to_string())
            })?)
            .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;
    }

    let terminal_message = GraphStreamCompletionMessage {
        message_type: "complete",
        completion,
    };
    let terminal_bytes = serde_json::to_vec(&terminal_message)
        .map_err(|error| AppError::InvalidParam(error.to_string()))?;
    transferred = transferred
        .checked_add(u64::try_from(terminal_bytes.len()).map_err(|_| {
            AppError::InvalidParam("terminal payload length overflow".to_string())
        })?)
        .ok_or_else(|| AppError::InvalidParam("transferred bytes overflow".to_string()))?;

    Ok(transferred)
}

fn execute_graph(options: Options, total_started: Instant) -> Result<PerformanceReport, AppError> {
    if options.columns < 2 {
        return Err(AppError::InvalidParam(
            "graph requires at least 2 columns".into(),
        ));
    }

    let setup_started = Instant::now();
    let state = AppState::new()?;
    let dataset_id = "performance-graph-baseline";
    seed_graph_benchmark_dataset(&state, dataset_id, options.rows)?;
    let generation = {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        db.get_dataset_generation(dataset_id)?
    };
    let request = build_graph_request(dataset_id, generation);
    let setup_ms = setup_started.elapsed().as_millis();

    let query_started = Instant::now();
    let mut query_processed_rows = 0u64;
    let mut query_selected_columns = 0usize;
    {
        let db = state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let stats = db.stream_graph_projection_rows(
            &request,
            true,
            |stats| {
                query_selected_columns = stats.projected_columns.len().saturating_add(1);
                Ok(())
            },
            |_row_id, _values, _row_source_rows| {
                query_processed_rows = query_processed_rows.saturating_add(1);
                Ok(true)
            },
        )?;
        if query_selected_columns == 0 {
            query_selected_columns = stats.projected_columns.len().saturating_add(1);
        }
    }
    let query_ms = query_started.elapsed().as_millis();

    let expected_rows = u64::try_from(options.rows)
        .map_err(|_| AppError::InvalidParam("benchmark row count is too large".into()))?;
    if query_processed_rows != expected_rows {
        return Err(AppError::InvalidParam(format!(
            "graph query processed_rows mismatch: expected {expected_rows}, got {query_processed_rows}"
        )));
    }
    if query_selected_columns != 3 {
        return Err(AppError::InvalidParam(format!(
            "graph projection selected column mismatch: expected 3, got {query_selected_columns}"
        )));
    }

    let operation_started = Instant::now();
    let service = GraphDataService::new(&state);
    let (chunks, completion) = service.collect_for_harness(&request)?;
    let operation_ms = operation_started.elapsed().as_millis();

    if completion.processed_rows != expected_rows {
        return Err(AppError::InvalidParam(format!(
            "graph service processed_rows mismatch: expected {expected_rows}, got {}",
            completion.processed_rows
        )));
    }
    let selected_columns = chunks
        .first()
        .map(|chunk| chunk.header.projected_columns.len())
        .unwrap_or(0);
    if selected_columns != 3 {
        return Err(AppError::InvalidParam(format!(
            "graph service selected column mismatch: expected 3, got {selected_columns}"
        )));
    }

    let transferred_bytes = measure_transferred_bytes(&chunks, &completion)?;
    let encode_ms = operation_ms.saturating_sub(query_ms);

    Ok(PerformanceReport {
        rows: options.rows,
        columns: options.columns,
        operation: options.operation,
        setup_ms,
        operation_ms,
        total_ms: total_started.elapsed().as_millis(),
        result_rows: usize::try_from(completion.processed_rows).map_err(|_| {
            AppError::InvalidParam("graph processed row count does not fit usize".to_string())
        })?,
        selected_columns,
        query_ms: Some(query_ms),
        encode_ms: Some(encode_ms),
        decode_ms: Some(DesktopOnlyMetric::DesktopOnly),
        draw_ms: Some(DesktopOnlyMetric::DesktopOnly),
        processed_rows: Some(completion.processed_rows),
        transferred_bytes: Some(transferred_bytes),
    })
}

fn execute(options: Options) -> Result<PerformanceReport, AppError> {
    let total_started = Instant::now();
    if options.operation == Operation::Graph {
        return execute_graph(options, total_started);
    }

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
    let (result_rows, selected_columns) = match options.operation {
        Operation::Query => (
            db.query_table("performance-baseline", 0, 500, None, None)?
                .rows
                .len(),
            0,
        ),
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
            (rows.len(), 0)
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
            (snapshot.rows.len(), 0)
        }
        Operation::Graph => unreachable!("graph operation is handled by execute_graph"),
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
        selected_columns,
        query_ms: None,
        encode_ms: None,
        decode_ms: None,
        draw_ms: None,
        processed_rows: None,
        transferred_bytes: None,
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
    fn performance_cli_parses_graph_operation() {
        let options = parse_args(["--operation", "graph"].map(String::from)).unwrap();

        assert_eq!(options.operation, Operation::Graph);
    }

    #[test]
    fn performance_cli_executes_each_operation() {
        for operation in [
            Operation::Query,
            Operation::Paste,
            Operation::Restore,
            Operation::Graph,
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
            assert_eq!(report.selected_columns, if operation == Operation::Graph { 3 } else { 0 });

            let json = serde_json::to_value(report).unwrap();
            assert!(json.get("setupMs").is_some());
            assert!(json.get("operationMs").is_some());
            assert!(json.get("totalMs").is_some());
        }
    }

    #[test]
    fn performance_cli_streams_graph_via_production_service() {
        let report = execute(Options {
            rows: 10_000,
            columns: 20,
            operation: Operation::Graph,
        })
        .unwrap();

        assert_eq!(report.result_rows, 10_000);
        assert_eq!(report.selected_columns, 3);
        assert_eq!(report.processed_rows, Some(10_000));
    }

    #[test]
    fn performance_cli_reports_graph_metrics_shape() {
        let report = execute(Options {
            rows: 10,
            columns: 20,
            operation: Operation::Graph,
        })
        .unwrap();

        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json.get("operation").and_then(|value| value.as_str()), Some("graph"));
        assert!(json.get("queryMs").and_then(|value| value.as_u64()).is_some());
        assert!(json.get("encodeMs").and_then(|value| value.as_u64()).is_some());
        assert_eq!(json.get("decodeMs").and_then(|value| value.as_str()), Some("desktop_only"));
        assert_eq!(json.get("drawMs").and_then(|value| value.as_str()), Some("desktop_only"));
        assert_eq!(json.get("processedRows").and_then(|value| value.as_u64()), Some(10));
        assert!(
            json.get("transferredBytes")
                .and_then(|value| value.as_u64())
                .is_some_and(|value| value > 0)
        );
    }

    #[test]
    fn performance_cli_rejects_graph_when_columns_below_two() {
        let result = execute(Options {
            rows: 10,
            columns: 1,
            operation: Operation::Graph,
        });

        match result {
            Ok(_) => panic!("expected graph to reject columns < 2"),
            Err(error) => {
                assert!(matches!(error, AppError::InvalidParam(_)));
                assert!(error.to_string().contains("graph requires at least 2 columns"));
            }
        }
    }
}