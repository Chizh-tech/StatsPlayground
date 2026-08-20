use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::table::TableWindowFilter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphFieldBinding {
    pub role: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphElementRequest {
    pub kind: String,
    pub summary_stat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphViewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GraphSampling {
    Full,
    Sample { size: usize, seed: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataRequest {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub fields: Vec<GraphFieldBinding>,
    pub filters: Vec<TableWindowFilter>,
    pub elements: Vec<GraphElementRequest>,
    pub sampling: GraphSampling,
    pub viewport: GraphViewport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphPayloadType {
    F64,
    U32,
    I64,
    U8,
}

impl GraphPayloadType {
    pub fn byte_width(&self) -> usize {
        match self {
            Self::F64 => 8,
            Self::U32 => 4,
            Self::I64 => 8,
            Self::U8 => 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphTypedSliceDescriptor {
    #[serde(rename = "type")]
    pub payload_type: GraphPayloadType,
    pub offset: usize,
    pub byte_length: usize,
}

impl GraphTypedSliceDescriptor {
    pub fn new(payload_type: GraphPayloadType, offset: usize, byte_length: usize) -> Self {
        Self {
            payload_type,
            offset,
            byte_length,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphAxisEncoding {
    Numeric,
    Categorical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChunkHeader {
    pub request_id: String,
    pub generation: u64,
    pub chunk_index: u32,
    pub row_offset: u64,
    pub row_count: usize,
    pub source_rows: u64,
    pub processed_rows: u64,
    pub projected_columns: Vec<String>,
    pub dictionaries: BTreeMap<String, Vec<String>>,
    pub validity_ranges: BTreeMap<String, GraphTypedSliceDescriptor>,
    pub x_values: GraphTypedSliceDescriptor,
    pub y_values: GraphTypedSliceDescriptor,
    pub row_ids: GraphTypedSliceDescriptor,
    pub group_codes: Option<GraphTypedSliceDescriptor>,
    pub size_values: Option<GraphTypedSliceDescriptor>,
    pub x_encoding: GraphAxisEncoding,
    pub final_chunk: bool,
}

impl GraphChunkHeader {
    pub fn validate_layout(&self, payload_len: usize) -> Result<(), String> {
        let mut slices: Vec<&GraphTypedSliceDescriptor> = vec![
            &self.x_values,
            &self.y_values,
            &self.row_ids,
        ];

        if let Some(group_codes) = &self.group_codes {
            slices.push(group_codes);
        }
        if let Some(size_values) = &self.size_values {
            slices.push(size_values);
        }

        for descriptor in self.validity_ranges.values() {
            slices.push(descriptor);
        }

        for descriptor in &slices {
            if descriptor.offset % 8 != 0 {
                return Err(format!(
                    "slice offset {} is not 8-byte aligned",
                    descriptor.offset
                ));
            }

            let type_width = descriptor.payload_type.byte_width();
            if descriptor.offset % type_width != 0 {
                return Err(format!(
                    "slice offset {} is not aligned for {:?}",
                    descriptor.offset, descriptor.payload_type
                ));
            }
            if descriptor.byte_length % type_width != 0 {
                return Err(format!(
                    "slice byte length {} is not divisible by {:?}",
                    descriptor.byte_length, descriptor.payload_type
                ));
            }

            let end = descriptor
                .offset
                .checked_add(descriptor.byte_length)
                .ok_or_else(|| "slice range overflow".to_string())?;

            if end > payload_len {
                return Err(format!(
                    "slice range [{}..{}) exceeds payload length {}",
                    descriptor.offset, end, payload_len
                ));
            }
        }

        let mut ranges: Vec<(usize, usize)> = slices
            .iter()
            .map(|descriptor| (descriptor.offset, descriptor.offset + descriptor.byte_length))
            .collect();
        ranges.sort_unstable_by_key(|range| range.0);

        for pair in ranges.windows(2) {
            let prev = pair[0];
            let next = pair[1];
            if prev.1 > next.0 {
                return Err(format!(
                    "slice overlap detected between [{}..{}) and [{}..{})",
                    prev.0, prev.1, next.0, next.1
                ));
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataCompletion {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub source_rows: u64,
    pub processed_rows: u64,
    pub chunks_sent: u32,
    pub cancelled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_request_deserializes_with_camel_case_fields() {
        let request: GraphDataRequest = serde_json::from_value(serde_json::json!({
            "requestId": "req-1",
            "datasetId": "dataset-id",
            "generation": 7,
            "fields": [
                { "role": "x", "column": "region" },
                { "role": "y", "column": "cost" }
            ],
            "filters": [],
            "elements": [{ "kind": "points", "summaryStat": "none" }],
            "sampling": { "mode": "full" },
            "viewport": { "width": 1200, "height": 700 }
        }))
        .unwrap();

        assert_eq!(request.request_id, "req-1");
        assert!(matches!(request.sampling, GraphSampling::Full));
    }

    #[test]
    fn chunk_layout_requires_eight_byte_alignment_and_non_overlapping_slices() {
        let header = GraphChunkHeader {
            request_id: "req-1".into(),
            generation: 3,
            chunk_index: 0,
            row_offset: 0,
            row_count: 2,
            source_rows: 2,
            processed_rows: 2,
            projected_columns: vec!["_row_id".into(), "x".into(), "y".into()],
            dictionaries: std::collections::BTreeMap::new(),
            validity_ranges: std::collections::BTreeMap::from([
                (
                    "x".into(),
                    GraphTypedSliceDescriptor::new(GraphPayloadType::U8, 72, 2),
                ),
            ]),
            x_values: GraphTypedSliceDescriptor::new(GraphPayloadType::F64, 0, 16),
            y_values: GraphTypedSliceDescriptor::new(GraphPayloadType::F64, 16, 16),
            row_ids: GraphTypedSliceDescriptor::new(GraphPayloadType::I64, 32, 16),
            group_codes: Some(GraphTypedSliceDescriptor::new(GraphPayloadType::U32, 48, 8)),
            size_values: Some(GraphTypedSliceDescriptor::new(GraphPayloadType::F64, 56, 16)),
            x_encoding: GraphAxisEncoding::Categorical,
            final_chunk: true,
        };

        assert!(header.validate_layout(80).is_ok());

        let mut misaligned = header.clone();
        misaligned.x_values.offset = 4;
        assert!(misaligned.validate_layout(80).is_err());

        let mut overlapping = header.clone();
        overlapping.y_values.offset = 8;
        assert!(overlapping.validate_layout(80).is_err());
    }
}