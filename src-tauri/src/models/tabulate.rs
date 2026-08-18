use serde::{Deserialize, Serialize};

/// Kinds of statistics that can be requested for a tabulate operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatisticKind {
    Count,
    MissingCount,
    UniqueCount,
    Sum,
    Mean,
    StandardDeviation,
    Variance,
    Minimum,
    Maximum,
    Median,
    Range,
    Quantile,
    RowPercentage,
    ColumnPercentage,
    TotalPercentage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateStatistic {
    pub id: String,
    pub field: String,
    pub kind: StatisticKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantile: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateRequest {
    pub dataset_id: String,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub statistics: Vec<TabulateStatistic>,
    pub include_row_totals: bool,
    pub include_column_totals: bool,
    pub max_result_cells: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabulateResult {
    pub row_members: Vec<Vec<serde_json::Value>>,
    pub column_members: Vec<Vec<serde_json::Value>>,
    pub statistics: Vec<TabulateStatistic>,
    pub cells: Vec<Option<f64>>,
    pub row_totals: Vec<Option<f64>>,
    pub column_totals: Vec<Option<f64>>,
    pub grand_totals: Vec<Option<f64>>,
    pub cell_count: u64,
    pub limit: u64,
}
