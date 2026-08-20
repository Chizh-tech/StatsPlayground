use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use duckdb::types::Value;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::engine::duckdb_engine::GraphProjectionStats;
use crate::error::AppError;
use crate::models::graph_data::{
    GraphAxisEncoding, GraphChunkHeader, GraphDataCompletion, GraphDataRequest, GraphPayloadType,
    GraphSampling, GraphTypedSliceDescriptor,
};
use crate::state::AppState;

const INITIAL_PAYLOAD_BUDGET_BYTES: usize = 4 * 1024 * 1024;

fn cancelled_requests() -> &'static Mutex<HashSet<String>> {
    static CANCELLED_REQUESTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED_REQUESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug, Clone)]
pub struct GraphDataChunk {
    pub header: GraphChunkHeader,
    pub payload: Vec<u8>,
}

pub struct GraphDataService<'a> {
    state: &'a AppState,
}

impl<'a> GraphDataService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn stream(
        &self,
        request: &GraphDataRequest,
        on_chunk: &Channel<InvokeResponseBody>,
    ) -> Result<GraphDataCompletion, AppError> {
        let (chunks, completion) = self.collect_chunks(request)?;
        for chunk in chunks {
            let header = serde_json::to_string(&chunk.header)
                .map_err(|error| AppError::InvalidParam(error.to_string()))?;
            if on_chunk.send(InvokeResponseBody::from(header)).is_err()
                || on_chunk.send(InvokeResponseBody::from(chunk.payload)).is_err()
            {
                if self.is_cancelled(&request.request_id)? {
                    return Ok(GraphDataCompletion {
                        request_id: request.request_id.clone(),
                        dataset_id: request.dataset_id.clone(),
                        generation: request.generation,
                        source_rows: completion.source_rows,
                        processed_rows: completion.processed_rows,
                        chunks_sent: completion.chunks_sent,
                        cancelled: true,
                    });
                }
                return Err(AppError::InvalidParam(
                    "graph data channel closed".to_string(),
                ));
            }
        }
        Ok(completion)
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), AppError> {
        if request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "request_id must not be blank".to_string(),
            ));
        }
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        cancelled.insert(request_id.to_string());
        Ok(())
    }

    pub fn collect_for_test(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphDataChunk>, AppError> {
        let (chunks, completion) = self.collect_chunks(request)?;
        if completion.cancelled {
            return Err(AppError::InvalidParam(
                "request was cancelled during graph projection".to_string(),
            ));
        }
        Ok(chunks)
    }

    fn collect_chunks(
        &self,
        request: &GraphDataRequest,
    ) -> Result<(Vec<GraphDataChunk>, GraphDataCompletion), AppError> {
        if request.request_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "request_id must not be blank".to_string(),
            ));
        }
        if request.dataset_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "dataset_id must not be blank".to_string(),
            ));
        }
        if request.fields.is_empty() {
            return Err(AppError::InvalidParam(
                "graph request must include at least one field".to_string(),
            ));
        }
        if !matches!(request.sampling, GraphSampling::Full) {
            return Err(AppError::InvalidParam(
                "graph sampling modes are not supported yet".to_string(),
            ));
        }

        self.clear_cancellation(&request.request_id)?;

        let include_row_id = request
            .elements
            .iter()
            .any(|element| element.kind.eq_ignore_ascii_case("points"));
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;

        let stats = db.stream_graph_projection_rows(request, include_row_id, |_row_id, _values| {
            Ok(false)
        })?;
        let metadata = ProjectionMetadata::new(request, include_row_id, &stats)?;

        let mut chunks = Vec::new();
        let mut accumulator = ChunkAccumulator::new(&metadata);
        let mut chunk_index: u32 = 0;
        let mut row_offset: u64 = 0;
        let mut processed_rows: u64 = 0;
        let mut cancelled = false;

        let _ = db.stream_graph_projection_rows(request, include_row_id, |row_id, values| {
            if self.is_cancelled(&request.request_id)? {
                cancelled = true;
                return Ok(false);
            }

            accumulator.push_row(&metadata, row_id, &values)?;
            processed_rows = processed_rows
                .checked_add(1)
                .ok_or_else(|| AppError::InvalidParam("graph processed row count overflow".into()))?;

            if accumulator.row_count() >= accumulator.rows_per_chunk {
                chunks.push(accumulator.finish_chunk(
                    &metadata,
                    request,
                    chunk_index,
                    row_offset,
                    stats.source_rows,
                    processed_rows,
                    false,
                )?);
                chunk_index = chunk_index.saturating_add(1);
                row_offset = processed_rows;
            }
            Ok(true)
        })?;

        if !cancelled {
            chunks.push(accumulator.finish_chunk(
                &metadata,
                request,
                chunk_index,
                row_offset,
                stats.source_rows,
                processed_rows,
                true,
            )?);
        }

        let completion = GraphDataCompletion {
            request_id: request.request_id.clone(),
            dataset_id: request.dataset_id.clone(),
            generation: request.generation,
            source_rows: stats.source_rows,
            processed_rows,
            chunks_sent: chunks.len() as u32,
            cancelled,
        };
        self.clear_cancellation(&request.request_id)?;
        Ok((chunks, completion))
    }

    fn is_cancelled(&self, request_id: &str) -> Result<bool, AppError> {
        let cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        Ok(cancelled.contains(request_id))
    }

    fn clear_cancellation(&self, request_id: &str) -> Result<(), AppError> {
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        cancelled.remove(request_id);
        Ok(())
    }
}

struct ProjectionMetadata {
    projected_columns: Vec<String>,
    include_row_id: bool,
    x_index: usize,
    y_index: usize,
    group_index: Option<usize>,
    size_index: Option<usize>,
    x_payload_type: GraphPayloadType,
    x_encoding: GraphAxisEncoding,
}

impl ProjectionMetadata {
    fn new(
        request: &GraphDataRequest,
        include_row_id: bool,
        stats: &GraphProjectionStats,
    ) -> Result<Self, AppError> {
        let mut role_columns: HashMap<String, String> = HashMap::new();
        for field in &request.fields {
            role_columns
                .entry(field.role.to_ascii_lowercase())
                .or_insert_with(|| field.column.clone());
        }

        let x_column = role_columns
            .get("x")
            .ok_or_else(|| AppError::InvalidParam("graph request is missing role x".to_string()))?;
        let y_column = role_columns
            .get("y")
            .ok_or_else(|| AppError::InvalidParam("graph request is missing role y".to_string()))?;

        let x_index = stats
            .projected_columns
            .iter()
            .position(|column| column == x_column)
            .ok_or_else(|| AppError::InvalidParam("unknown graph column for role x".to_string()))?;
        let y_index = stats
            .projected_columns
            .iter()
            .position(|column| column == y_column)
            .ok_or_else(|| AppError::InvalidParam("unknown graph column for role y".to_string()))?;

        let group_index = role_columns
            .get("group")
            .and_then(|column| stats.projected_columns.iter().position(|name| name == column));
        let size_index = role_columns
            .get("size")
            .and_then(|column| stats.projected_columns.iter().position(|name| name == column));

        let x_type = stats
            .projected_column_types
            .get(x_index)
            .ok_or_else(|| AppError::InvalidParam("x column type missing".to_string()))?;
        let (x_payload_type, x_encoding) = if is_numeric_type(x_type) {
            (GraphPayloadType::F64, GraphAxisEncoding::Numeric)
        } else {
            (GraphPayloadType::U32, GraphAxisEncoding::Categorical)
        };

        let mut projected_columns = Vec::new();
        if include_row_id {
            projected_columns.push("_row_id".to_string());
        }
        projected_columns.extend(stats.projected_columns.iter().cloned());

        Ok(Self {
            projected_columns,
            include_row_id,
            x_index,
            y_index,
            group_index,
            size_index,
            x_payload_type,
            x_encoding,
        })
    }

    fn rows_per_chunk(&self) -> usize {
        let mut row_width = self.x_payload_type.byte_width() + GraphPayloadType::F64.byte_width();
        if self.include_row_id {
            row_width += GraphPayloadType::I64.byte_width();
        }
        if self.group_index.is_some() {
            row_width += GraphPayloadType::U32.byte_width();
        }
        if self.size_index.is_some() {
            row_width += GraphPayloadType::F64.byte_width();
        }
        row_width += 2;
        if self.group_index.is_some() {
            row_width += 1;
        }
        if self.size_index.is_some() {
            row_width += 1;
        }
        std::cmp::max(1, INITIAL_PAYLOAD_BUDGET_BYTES / row_width)
    }
}

struct ChunkAccumulator {
    rows_per_chunk: usize,
    x_numeric_values: Vec<f64>,
    x_categorical_values: Vec<u32>,
    y_values: Vec<f64>,
    row_ids: Vec<i64>,
    group_codes: Vec<u32>,
    size_values: Vec<f64>,
    x_validity: Vec<u8>,
    y_validity: Vec<u8>,
    group_validity: Vec<u8>,
    size_validity: Vec<u8>,
    x_dictionary: Vec<String>,
    x_dictionary_index: HashMap<String, u32>,
    group_dictionary: Vec<String>,
    group_dictionary_index: HashMap<String, u32>,
}

impl ChunkAccumulator {
    fn new(metadata: &ProjectionMetadata) -> Self {
        let rows_per_chunk = metadata.rows_per_chunk();
        Self {
            rows_per_chunk,
            x_numeric_values: Vec::with_capacity(rows_per_chunk),
            x_categorical_values: Vec::with_capacity(rows_per_chunk),
            y_values: Vec::with_capacity(rows_per_chunk),
            row_ids: Vec::with_capacity(rows_per_chunk),
            group_codes: Vec::with_capacity(rows_per_chunk),
            size_values: Vec::with_capacity(rows_per_chunk),
            x_validity: Vec::with_capacity(rows_per_chunk),
            y_validity: Vec::with_capacity(rows_per_chunk),
            group_validity: Vec::with_capacity(rows_per_chunk),
            size_validity: Vec::with_capacity(rows_per_chunk),
            x_dictionary: Vec::new(),
            x_dictionary_index: HashMap::new(),
            group_dictionary: Vec::new(),
            group_dictionary_index: HashMap::new(),
        }
    }

    fn row_count(&self) -> usize {
        self.y_values.len()
    }

    fn push_row(
        &mut self,
        metadata: &ProjectionMetadata,
        row_id: Option<i64>,
        values: &[Value],
    ) -> Result<(), AppError> {
        let x = values
            .get(metadata.x_index)
            .ok_or_else(|| AppError::Database("x value missing from graph projection".to_string()))?;
        match metadata.x_payload_type {
            GraphPayloadType::F64 => {
                if let Some(value) = value_to_f64(x) {
                    self.x_numeric_values.push(value);
                    self.x_validity.push(1);
                } else {
                    self.x_numeric_values.push(0.0);
                    self.x_validity.push(0);
                }
            }
            GraphPayloadType::U32 => {
                if let Some(label) = value_to_category(x) {
                    let code = upsert_code(
                        &mut self.x_dictionary,
                        &mut self.x_dictionary_index,
                        &label,
                    )?;
                    self.x_categorical_values.push(code);
                    self.x_validity.push(1);
                } else {
                    self.x_categorical_values.push(0);
                    self.x_validity.push(0);
                }
            }
            _ => {
                return Err(AppError::Database(
                    "unsupported x payload type for graph chunk".to_string(),
                ));
            }
        }

        let y = values
            .get(metadata.y_index)
            .ok_or_else(|| AppError::Database("y value missing from graph projection".to_string()))?;
        if let Some(value) = value_to_f64(y) {
            self.y_values.push(value);
            self.y_validity.push(1);
        } else {
            self.y_values.push(0.0);
            self.y_validity.push(0);
        }

        if metadata.include_row_id {
            self.row_ids.push(row_id.ok_or_else(|| {
                AppError::Database("row id missing for point interaction".to_string())
            })?);
        }

        if let Some(group_index) = metadata.group_index {
            let group = values.get(group_index).ok_or_else(|| {
                AppError::Database("group value missing from graph projection".to_string())
            })?;
            if let Some(label) = value_to_category(group) {
                let code = upsert_code(
                    &mut self.group_dictionary,
                    &mut self.group_dictionary_index,
                    &label,
                )?;
                self.group_codes.push(code);
                self.group_validity.push(1);
            } else {
                self.group_codes.push(0);
                self.group_validity.push(0);
            }
        }

        if let Some(size_index) = metadata.size_index {
            let size = values.get(size_index).ok_or_else(|| {
                AppError::Database("size value missing from graph projection".to_string())
            })?;
            if let Some(value) = value_to_f64(size) {
                self.size_values.push(value);
                self.size_validity.push(1);
            } else {
                self.size_values.push(0.0);
                self.size_validity.push(0);
            }
        }

        Ok(())
    }

    fn finish_chunk(
        &mut self,
        metadata: &ProjectionMetadata,
        request: &GraphDataRequest,
        chunk_index: u32,
        row_offset: u64,
        source_rows: u64,
        processed_rows: u64,
        final_chunk: bool,
    ) -> Result<GraphDataChunk, AppError> {
        let row_count = self.row_count();
        let mut payload = Vec::new();

        let x_values = match metadata.x_payload_type {
            GraphPayloadType::F64 => {
                descriptor_from_f64(&mut payload, &self.x_numeric_values, GraphPayloadType::F64)
            }
            GraphPayloadType::U32 => descriptor_from_u32(
                &mut payload,
                &self.x_categorical_values,
                GraphPayloadType::U32,
            ),
            _ => {
                return Err(AppError::Database(
                    "unsupported x payload type while encoding graph chunk".to_string(),
                ));
            }
        };

        let y_values = descriptor_from_f64(&mut payload, &self.y_values, GraphPayloadType::F64);
        let row_ids = if metadata.include_row_id {
            descriptor_from_i64(&mut payload, &self.row_ids, GraphPayloadType::I64)
        } else {
            GraphTypedSliceDescriptor::new(GraphPayloadType::I64, payload.len(), 0)
        };

        let group_codes = if metadata.group_index.is_some() {
            Some(descriptor_from_u32(
                &mut payload,
                &self.group_codes,
                GraphPayloadType::U32,
            ))
        } else {
            None
        };

        let size_values = if metadata.size_index.is_some() {
            Some(descriptor_from_f64(
                &mut payload,
                &self.size_values,
                GraphPayloadType::F64,
            ))
        } else {
            None
        };

        let mut validity_ranges = BTreeMap::new();
        validity_ranges.insert(
            "x".to_string(),
            descriptor_from_u8(&mut payload, &self.x_validity, GraphPayloadType::U8),
        );
        validity_ranges.insert(
            "y".to_string(),
            descriptor_from_u8(&mut payload, &self.y_validity, GraphPayloadType::U8),
        );
        if metadata.group_index.is_some() {
            validity_ranges.insert(
                "group".to_string(),
                descriptor_from_u8(&mut payload, &self.group_validity, GraphPayloadType::U8),
            );
        }
        if metadata.size_index.is_some() {
            validity_ranges.insert(
                "size".to_string(),
                descriptor_from_u8(&mut payload, &self.size_validity, GraphPayloadType::U8),
            );
        }

        let mut dictionaries = BTreeMap::new();
        if metadata.x_payload_type == GraphPayloadType::U32 {
            dictionaries.insert("x".to_string(), self.x_dictionary.clone());
        }
        if metadata.group_index.is_some() {
            dictionaries.insert("group".to_string(), self.group_dictionary.clone());
        }

        let header = GraphChunkHeader {
            request_id: request.request_id.clone(),
            generation: request.generation,
            chunk_index,
            row_offset,
            row_count,
            source_rows,
            processed_rows,
            projected_columns: metadata.projected_columns.clone(),
            dictionaries,
            validity_ranges,
            x_values,
            y_values,
            row_ids,
            group_codes,
            size_values,
            x_encoding: metadata.x_encoding.clone(),
            final_chunk,
        };
        header
            .validate_layout(payload.len())
            .map_err(AppError::InvalidParam)?;

        self.reset_for_next_chunk();
        Ok(GraphDataChunk { header, payload })
    }

    fn reset_for_next_chunk(&mut self) {
        self.x_numeric_values.clear();
        self.x_categorical_values.clear();
        self.y_values.clear();
        self.row_ids.clear();
        self.group_codes.clear();
        self.size_values.clear();
        self.x_validity.clear();
        self.y_validity.clear();
        self.group_validity.clear();
        self.size_validity.clear();
        self.x_dictionary.clear();
        self.x_dictionary_index.clear();
        self.group_dictionary.clear();
        self.group_dictionary_index.clear();
    }
}

fn upsert_code(
    dictionary: &mut Vec<String>,
    index: &mut HashMap<String, u32>,
    value: &str,
) -> Result<u32, AppError> {
    if let Some(existing) = index.get(value) {
        return Ok(*existing);
    }
    let code = u32::try_from(dictionary.len()).map_err(|_| {
        AppError::InvalidParam("too many categorical values for graph payload".to_string())
    })?;
    dictionary.push(value.to_string());
    index.insert(value.to_string(), code);
    Ok(code)
}

fn is_numeric_type(column_type: &str) -> bool {
    let normalized = column_type.to_ascii_uppercase();
    normalized.contains("INT")
        || normalized.contains("DECIMAL")
        || normalized.contains("NUMERIC")
        || normalized.contains("DOUBLE")
        || normalized.contains("FLOAT")
        || normalized.contains("REAL")
}

fn value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::TinyInt(value) => Some(*value as f64),
        Value::SmallInt(value) => Some(*value as f64),
        Value::Int(value) => Some(*value as f64),
        Value::BigInt(value) => Some(*value as f64),
        Value::UTinyInt(value) => Some(*value as f64),
        Value::USmallInt(value) => Some(*value as f64),
        Value::UInt(value) => Some(*value as f64),
        Value::UBigInt(value) => Some(*value as f64),
        Value::Float(value) => Some(*value as f64),
        Value::Double(value) => Some(*value),
        Value::Text(value) => value.parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_category(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Text(value) => Some(value.clone()),
        Value::Boolean(value) => Some(value.to_string()),
        Value::TinyInt(value) => Some(value.to_string()),
        Value::SmallInt(value) => Some(value.to_string()),
        Value::Int(value) => Some(value.to_string()),
        Value::BigInt(value) => Some(value.to_string()),
        Value::UTinyInt(value) => Some(value.to_string()),
        Value::USmallInt(value) => Some(value.to_string()),
        Value::UInt(value) => Some(value.to_string()),
        Value::UBigInt(value) => Some(value.to_string()),
        Value::Float(value) => Some(value.to_string()),
        Value::Double(value) => Some(value.to_string()),
        _ => Some(format!("{value:?}")),
    }
}

fn pad_to_eight(payload: &mut Vec<u8>) {
    let aligned = (payload.len() + 7) & !7;
    if aligned > payload.len() {
        payload.resize(aligned, 0);
    }
}

fn descriptor_from_f64(
    payload: &mut Vec<u8>,
    values: &[f64],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 8)
}

fn descriptor_from_i64(
    payload: &mut Vec<u8>,
    values: &[i64],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 8)
}

fn descriptor_from_u32(
    payload: &mut Vec<u8>,
    values: &[u32],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    for value in values {
        payload.extend_from_slice(&value.to_ne_bytes());
    }
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len() * 4)
}

fn descriptor_from_u8(
    payload: &mut Vec<u8>,
    values: &[u8],
    payload_type: GraphPayloadType,
) -> GraphTypedSliceDescriptor {
    pad_to_eight(payload);
    let offset = payload.len();
    payload.extend_from_slice(values);
    GraphTypedSliceDescriptor::new(payload_type, offset, values.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    use duckdb::params;

    use crate::models::graph_data::{
        GraphDataRequest, GraphElementRequest, GraphFieldBinding, GraphSampling, GraphViewport,
    };
    use crate::models::table::{TableWindowFilter, TableWindowFilterRule};
    use crate::state::AppState;

    fn build_request(dataset_id: &str, generation: u64) -> GraphDataRequest {
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

    fn seed_dataset(state: &AppState, dataset_id: &str, rows: usize) {
        let db = state.db.lock().expect("db lock");
        db.create_empty_table(
            dataset_id,
            &format!("Dataset {dataset_id}"),
            &["region".into(), "cost".into()],
            &["VARCHAR".into(), "DOUBLE".into()],
        )
        .expect("create table");

        if rows > 0 {
            let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));
            let upper_bound = i64::try_from(rows)
                .ok()
                .and_then(|value| value.checked_add(1))
                .expect("rows upper bound");
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
            db.conn()
                .execute(&insert_sql, params![upper_bound])
                .expect("bulk insert rows");
            db.conn()
                .execute(
                    "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
                    params![rows as i64, dataset_id],
                )
                .expect("update row count");
        }
    }

    #[test]
    fn collect_for_test_handles_scale_matrix() {
        for row_count in [0usize, 1, 10, 5_000, 300_000] {
            let state = AppState::new().expect("state");
            let dataset_id = format!("scale-{row_count}");
            seed_dataset(&state, &dataset_id, row_count);

            let service = GraphDataService::new(&state);
            let request = build_request(&dataset_id, 0);
            let chunks = service.collect_for_test(&request).expect("chunks");

            assert_eq!(
                chunks
                    .iter()
                    .map(|chunk| chunk.header.row_count)
                    .sum::<usize>(),
                row_count
            );
            assert_eq!(chunks.last().expect("final chunk").header.final_chunk, true);
            assert_eq!(
                chunks[0].header.projected_columns,
                vec!["_row_id", "region", "cost"]
            );
        }
    }

    #[test]
    fn collect_for_test_rejects_stale_generation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "stale-gen", 3);

        let db = state.db.lock().expect("db lock");
        db.conn()
            .execute(
                "UPDATE _meta_datasets SET generation = 1 WHERE id = $1",
                params!["stale-gen"],
            )
            .expect("update generation");
        drop(db);

        let service = GraphDataService::new(&state);
        let request = build_request("stale-gen", 0);
        let error = service.collect_for_test(&request).expect_err("stale generation must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("stale dataset generation")));
    }

    #[test]
    fn collect_for_test_rejects_unknown_column() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "unknown-column", 3);

        let service = GraphDataService::new(&state);
        let mut request = build_request("unknown-column", 0);
        request.fields[0].column = "missing".to_string();

        let error = service.collect_for_test(&request).expect_err("unknown column must fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("unknown graph column")));
    }

    #[test]
    fn collect_for_test_keeps_row_ids_unique_across_chunk_boundaries() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "chunk-ids", 300_000);

        let service = GraphDataService::new(&state);
        let request = build_request("chunk-ids", 0);
        let chunks = service.collect_for_test(&request).expect("chunks");

        let mut all_ids = HashSet::new();
        for chunk in &chunks {
            for value in extract_i64_slice(chunk, &chunk.header.row_ids) {
                assert!(all_ids.insert(value));
            }
        }
        assert_eq!(all_ids.len(), 300_000);
    }

    #[test]
    fn collect_for_test_applies_filters_before_encoding() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "filtered", 20);

        let service = GraphDataService::new(&state);
        let mut request = build_request("filtered", 0);
        request.filters = vec![TableWindowFilter {
            op: "AND".to_string(),
            rule: TableWindowFilterRule::Categorical {
                field: "region".to_string(),
                selected: vec!["North".to_string()],
                exclude: false,
            },
        }];

        let chunks = service.collect_for_test(&request).expect("chunks");
        let total_rows = chunks.iter().map(|chunk| chunk.header.row_count).sum::<usize>();
        assert_eq!(total_rows, 4);
    }

    fn extract_i64_slice(chunk: &GraphDataChunk, descriptor: &crate::models::graph_data::GraphTypedSliceDescriptor) -> Vec<i64> {
        let mut result = Vec::new();
        let mut offset = descriptor.offset;
        let end = descriptor.offset + descriptor.byte_length;
        while offset < end {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&chunk.payload[offset..offset + 8]);
            result.push(i64::from_ne_bytes(bytes));
            offset += 8;
        }
        result
    }
}

