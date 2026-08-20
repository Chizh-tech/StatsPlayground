use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
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

#[derive(Debug, Clone)]
struct CancellationEntry {
    cancelled: bool,
    nonce: u64,
}

fn cancelled_requests() -> &'static Mutex<HashMap<String, CancellationEntry>> {
    static CANCELLED_REQUESTS: OnceLock<Mutex<HashMap<String, CancellationEntry>>> = OnceLock::new();
    CANCELLED_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy)]
struct RequestRun {
    nonce: u64,
    pre_cancelled: bool,
}

#[derive(Debug)]
enum GraphSinkError {
    Closed,
    Invalid(String),
}

trait GraphChunkSink {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError>;

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError>;
}

struct ChannelChunkSink<'a> {
    on_chunk: &'a Channel<InvokeResponseBody>,
}

impl GraphChunkSink for ChannelChunkSink<'_> {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
        let serialized = serde_json::to_string(header)
            .map_err(|error| GraphSinkError::Invalid(error.to_string()))?;
        if self
            .on_chunk
            .send(InvokeResponseBody::from(serialized))
            .is_err()
        {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
        if self.on_chunk.send(InvokeResponseBody::from(payload)).is_err() {
            return Err(GraphSinkError::Closed);
        }
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
struct CollectingChunkSink {
    chunks: Vec<GraphDataChunk>,
    pending_header: Option<GraphChunkHeader>,
}

#[cfg(test)]
impl CollectingChunkSink {
    fn into_chunks(self) -> Result<Vec<GraphDataChunk>, AppError> {
        if self.pending_header.is_some() {
            return Err(AppError::Database(
                "graph chunk header was not followed by payload".to_string(),
            ));
        }
        Ok(self.chunks)
    }
}

#[cfg(test)]
impl GraphChunkSink for CollectingChunkSink {
    fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
        if self.pending_header.is_some() {
            return Err(GraphSinkError::Invalid(
                "graph sink received a header before payload".to_string(),
            ));
        }
        self.pending_header = Some(header.clone());
        Ok(())
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
        let Some(header) = self.pending_header.take() else {
            return Err(GraphSinkError::Invalid(
                "graph sink received payload before header".to_string(),
            ));
        };
        self.chunks.push(GraphDataChunk { header, payload });
        Ok(())
    }
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
        let mut sink = ChannelChunkSink { on_chunk };
        self.stream_with_sink(request, &mut sink)
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
        let entry = cancelled
            .entry(request_id.to_string())
            .or_insert(CancellationEntry {
                cancelled: false,
                nonce: 0,
            });
        entry.cancelled = true;
        entry.nonce = entry.nonce.saturating_add(1);
        Ok(())
    }

    #[cfg(test)]
    pub fn collect_for_test(
        &self,
        request: &GraphDataRequest,
    ) -> Result<Vec<GraphDataChunk>, AppError> {
        let mut sink = CollectingChunkSink::default();
        let completion = self.stream_with_sink(request, &mut sink)?;
        if completion.cancelled {
            return Err(AppError::InvalidParam(
                "request was cancelled during graph projection".to_string(),
            ));
        }
        sink.into_chunks()
    }

    fn stream_with_sink<S: GraphChunkSink>(
        &self,
        request: &GraphDataRequest,
        sink: &mut S,
    ) -> Result<GraphDataCompletion, AppError> {
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

        let run = self.begin_request_run(&request.request_id)?;
        if run.pre_cancelled {
            self.finish_request_run(&request.request_id, run.nonce, true)?;
            return Ok(GraphDataCompletion {
                request_id: request.request_id.clone(),
                dataset_id: request.dataset_id.clone(),
                generation: request.generation,
                source_rows: 0,
                processed_rows: 0,
                chunks_sent: 0,
                cancelled: true,
            });
        }

        let result = (|| -> Result<GraphDataCompletion, AppError> {
            let include_row_id = request
                .elements
                .iter()
                .any(|element| element.kind.eq_ignore_ascii_case("points"));
            let db = self
                .state
                .db
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;

            let metadata: RefCell<Option<ProjectionMetadata>> = RefCell::new(None);
            let accumulator: RefCell<Option<ChunkAccumulator>> = RefCell::new(None);
            let mut chunk_index: u32 = 0;
            let mut row_offset: u64 = 0;
            let mut processed_rows: u64 = 0;
            let mut source_rows: u64 = 0;
            let mut chunks_sent: u32 = 0;
            let mut cancelled = false;
            let mut projection_callbacks: u32 = 0;

            let stats = db.stream_graph_projection_rows(
                request,
                include_row_id,
                |stats| {
                    projection_callbacks = projection_callbacks.saturating_add(1);
                    if projection_callbacks > 1 {
                        return Err(AppError::Database(
                            "graph projection callback invoked multiple times".to_string(),
                        ));
                    }
                    let resolved = ProjectionMetadata::new(request, include_row_id, stats)?;
                    *accumulator.borrow_mut() = Some(ChunkAccumulator::new(&resolved));
                    *metadata.borrow_mut() = Some(resolved);
                    Ok(())
                },
                |row_id, values, row_source_rows| {
                    source_rows = row_source_rows;
                    if self.is_cancelled(&request.request_id, run.nonce)? {
                        cancelled = true;
                        return Ok(false);
                    }

                    let metadata_ref = metadata.borrow();
                    let metadata = metadata_ref.as_ref().ok_or_else(|| {
                        AppError::Database("graph projection metadata not initialized".to_string())
                    })?;
                    let mut accumulator_ref = accumulator.borrow_mut();
                    let accumulator = accumulator_ref.as_mut().ok_or_else(|| {
                        AppError::Database("graph chunk accumulator not initialized".to_string())
                    })?;

                    accumulator.push_row(metadata, row_id, &values)?;
                    processed_rows = processed_rows.checked_add(1).ok_or_else(|| {
                        AppError::InvalidParam("graph processed row count overflow".into())
                    })?;

                    if accumulator.row_count() >= accumulator.rows_per_chunk {
                        let chunk = accumulator.finish_chunk(
                            metadata,
                            request,
                            chunk_index,
                            row_offset,
                            source_rows,
                            processed_rows,
                            false,
                        )?;
                        if let Err(error) = self.send_chunk(sink, chunk) {
                            if self.is_cancelled(&request.request_id, run.nonce)? {
                                cancelled = true;
                                return Ok(false);
                            }
                            return Err(error);
                        }
                        chunks_sent = chunks_sent.saturating_add(1);
                        chunk_index = chunk_index.saturating_add(1);
                        row_offset = processed_rows;
                    }
                    Ok(true)
                },
            )?;

            if projection_callbacks != 1 {
                return Err(AppError::Database(
                    "graph projection callback was not invoked exactly once".to_string(),
                ));
            }

            source_rows = stats.source_rows;
            if !cancelled {
                let metadata_ref = metadata.borrow();
                let metadata = metadata_ref.as_ref().ok_or_else(|| {
                    AppError::Database("graph projection metadata not initialized".to_string())
                })?;
                let mut accumulator_ref = accumulator.borrow_mut();
                let accumulator = accumulator_ref.as_mut().ok_or_else(|| {
                    AppError::Database("graph chunk accumulator not initialized".to_string())
                })?;

                let chunk = accumulator.finish_chunk(
                    metadata,
                    request,
                    chunk_index,
                    row_offset,
                    source_rows,
                    processed_rows,
                    true,
                )?;
                if let Err(error) = self.send_chunk(sink, chunk) {
                    if self.is_cancelled(&request.request_id, run.nonce)? {
                        cancelled = true;
                    } else {
                        return Err(error);
                    }
                } else {
                    chunks_sent = chunks_sent.saturating_add(1);
                }
            }

            Ok(GraphDataCompletion {
                request_id: request.request_id.clone(),
                dataset_id: request.dataset_id.clone(),
                generation: request.generation,
                source_rows,
                processed_rows,
                chunks_sent,
                cancelled,
            })
        })();

        let observed_cancelled = matches!(&result, Ok(completion) if completion.cancelled);
        self.finish_request_run(&request.request_id, run.nonce, observed_cancelled)?;
        result
    }

    fn send_chunk<S: GraphChunkSink>(
        &self,
        sink: &mut S,
        chunk: GraphDataChunk,
    ) -> Result<(), AppError> {
        sink.send_header(&chunk.header)
            .map_err(Self::map_sink_error_to_app_error)?;
        sink.send_payload(chunk.payload)
            .map_err(Self::map_sink_error_to_app_error)?;
        Ok(())
    }

    fn map_sink_error_to_app_error(error: GraphSinkError) -> AppError {
        match error {
            GraphSinkError::Closed => AppError::InvalidParam("graph data channel closed".to_string()),
            GraphSinkError::Invalid(message) => AppError::InvalidParam(message),
        }
    }

    fn begin_request_run(&self, request_id: &str) -> Result<RequestRun, AppError> {
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let entry = cancelled
            .entry(request_id.to_string())
            .or_insert(CancellationEntry {
                cancelled: false,
                nonce: 0,
            });
        entry.nonce = entry.nonce.saturating_add(1);
        let pre_cancelled = entry.cancelled;
        if pre_cancelled {
            entry.cancelled = false;
        }
        Ok(RequestRun {
            nonce: entry.nonce,
            pre_cancelled,
        })
    }

    fn is_cancelled(&self, request_id: &str, run_nonce: u64) -> Result<bool, AppError> {
        let cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(entry) = cancelled.get(request_id) else {
            return Ok(false);
        };
        Ok(entry.cancelled && entry.nonce > run_nonce)
    }

    fn finish_request_run(
        &self,
        request_id: &str,
        run_nonce: u64,
        observed_cancelled: bool,
    ) -> Result<(), AppError> {
        let mut cancelled = cancelled_requests()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let remove_entry = if let Some(entry) = cancelled.get(request_id) {
            if entry.nonce == run_nonce {
                true
            } else {
                observed_cancelled
                    && entry.cancelled
                    && entry.nonce == run_nonce.saturating_add(1)
            }
        } else {
            false
        };
        if remove_entry {
            cancelled.remove(request_id);
        }
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
        // Reserve fixed headroom for per-slice alignment padding so payload stays under budget.
        let payload_budget = INITIAL_PAYLOAD_BUDGET_BYTES.saturating_sub(64);
        std::cmp::max(1, payload_budget / row_width)
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

    #[derive(Default)]
    struct BoundedSink {
        first_header_processed_rows: Option<u64>,
        first_header_source_rows: Option<u64>,
        pending_chunks: usize,
        max_pending_chunks: usize,
        pending_payload_bytes: usize,
        max_pending_payload_bytes: usize,
    }

    impl GraphChunkSink for BoundedSink {
        fn send_header(&mut self, header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            if self.first_header_processed_rows.is_none() {
                self.first_header_processed_rows = Some(header.processed_rows);
                self.first_header_source_rows = Some(header.source_rows);
            }
            self.pending_chunks = self.pending_chunks.saturating_add(1);
            self.max_pending_chunks = self.max_pending_chunks.max(self.pending_chunks);
            Ok(())
        }

        fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), GraphSinkError> {
            self.pending_payload_bytes = self.pending_payload_bytes.saturating_add(payload.len());
            self.max_pending_payload_bytes =
                self.max_pending_payload_bytes.max(self.pending_payload_bytes);
            self.pending_payload_bytes = self.pending_payload_bytes.saturating_sub(payload.len());
            self.pending_chunks = self.pending_chunks.saturating_sub(1);
            Ok(())
        }
    }

    #[derive(Default)]
    struct OrderingSink {
        events: Vec<&'static str>,
    }

    impl GraphChunkSink for OrderingSink {
        fn send_header(&mut self, _header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            self.events.push("header");
            Ok(())
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), GraphSinkError> {
            self.events.push("payload");
            Ok(())
        }
    }

    struct ClosedSink;

    impl GraphChunkSink for ClosedSink {
        fn send_header(&mut self, _header: &GraphChunkHeader) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), GraphSinkError> {
            Err(GraphSinkError::Closed)
        }
    }

    #[test]
    fn stream_with_sink_emits_first_chunk_before_all_rows_and_bounds_inflight_payload() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "bounded-stream", 300_000);

        let service = GraphDataService::new(&state);
        let request = build_request("bounded-stream", 0);
        let mut sink = BoundedSink::default();

        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("stream completion");

        assert!(!completion.cancelled);
        assert_eq!(completion.processed_rows, 300_000);
        assert!(completion.chunks_sent > 1);

        let first_processed = sink
            .first_header_processed_rows
            .expect("expected at least one header event");
        let first_source = sink
            .first_header_source_rows
            .expect("expected source row metadata on first header");
        assert!(first_processed < first_source);
        assert!(sink.max_pending_chunks <= 1);
        assert!(sink.max_pending_payload_bytes <= INITIAL_PAYLOAD_BUDGET_BYTES);
    }

    #[test]
    fn stream_with_sink_respects_pre_start_cancellation() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "prestart-cancel", 128);

        let service = GraphDataService::new(&state);
        let request = build_request("prestart-cancel", 0);
        service.cancel(&request.request_id).expect("cancel request");

        let mut sink = OrderingSink::default();
        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("prestart cancellation should be observed");

        assert!(completion.cancelled);
        assert_eq!(completion.processed_rows, 0);
        assert_eq!(completion.chunks_sent, 0);
        assert!(sink.events.is_empty());
    }

    #[test]
    fn stream_with_sink_orders_header_then_payload() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "ordered-events", 32);

        let service = GraphDataService::new(&state);
        let request = build_request("ordered-events", 0);
        let mut sink = OrderingSink::default();

        let completion = service
            .stream_with_sink(&request, &mut sink)
            .expect("stream completion");
        assert!(!completion.cancelled);
        assert!(!sink.events.is_empty());
        assert_eq!(sink.events.len() % 2, 0);
        for pair in sink.events.chunks(2) {
            assert_eq!(pair[0], "header");
            assert_eq!(pair[1], "payload");
        }
    }

    #[test]
    fn stream_with_sink_maps_closed_sink_to_invalid_param() {
        let state = AppState::new().expect("state");
        seed_dataset(&state, "closed-sink", 8);

        let service = GraphDataService::new(&state);
        let request = build_request("closed-sink", 0);
        let mut sink = ClosedSink;

        let error = service
            .stream_with_sink(&request, &mut sink)
            .expect_err("closed sink should fail");
        assert!(matches!(error, AppError::InvalidParam(message) if message.contains("graph data channel closed")));
    }
}

