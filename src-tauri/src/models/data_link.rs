use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceColumn {
    pub name: String,
    pub source_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceObject {
    pub name: String,
    pub object_type: String,
    pub columns: Vec<SourceColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub object_name: String,
    pub columns: Vec<SourceColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqliteImportSelection {
    pub source_name: String,
    pub target_name: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTableSummary {
    pub source_name: String,
    pub target_name: String,
    pub action: String,
    pub rows_written: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub status: String,
    pub imported: Vec<ImportTableSummary>,
    pub skipped: Vec<ImportTableSummary>,
    pub failed_table: Option<String>,
    pub error: Option<String>,
    pub total_rows_written: usize,
}
