use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub type DistributionSchemaVersionV1 = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionModeV1 {
    EmptySystem,
    Continuous,
    Ordinal,
    Nominal,
    DiscreteNumeric,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionModelingTypeV1 {
    Continuous,
    Ordinal,
    Nominal,
    DiscreteNumeric,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionColumnRefV1 {
    pub column_id: String,
    pub modeling_type: DistributionModelingTypeV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSnapshotV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub snapshot_id: String,
    pub source_dataset_id: String,
    pub source_data_version: String,
    pub column_schema_fingerprint: String,
    pub filter_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FilterExprV1 {
    And {
        exprs: Vec<FilterExprV1>,
    },
    Or {
        exprs: Vec<FilterExprV1>,
    },
    Not {
        expr: Box<FilterExprV1>,
    },
    IsNull {
        field_id: String,
        negate: bool,
    },
    NumericRange {
        field_id: String,
        min: Option<f64>,
        max: Option<f64>,
        include_min: bool,
        include_max: bool,
    },
    CategorySet {
        field_id: String,
        values: Vec<String>,
        negate: bool,
    },
    DateRange {
        field_id: String,
        start: Option<String>,
        end: Option<String>,
        include_start: bool,
        include_end: bool,
        time_zone: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContributionDimensionV1 {
    pub code: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContributionPolicyV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub dimensions: Vec<ObservationContributionDimensionV1>,
}

impl ObservationContributionPolicyV1 {
    pub fn strict_v1() -> Result<Self, AppError> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/distribution/observation-contribution-v1.json"
        )))
        .map_err(|error| AppError::InvalidParam(format!("invalid observation policy: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudgetV1 {
    pub max_groups: u64,
    pub max_rows_per_group: u64,
    pub max_total_rows: u64,
    pub max_total_bytes: u64,
    pub cancel_token: Option<String>,
}

impl Default for ResourceBudgetV1 {
    fn default() -> Self {
        Self {
            max_groups: 1_000,
            max_rows_per_group: 100_000,
            max_total_rows: 1_000_000,
            max_total_bytes: 64 * 1024 * 1024,
            cancel_token: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRequestV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub analysis_id: String,
    pub config_revision: u64,
    pub run_id: String,
    pub source_dataset_id: Option<String>,
    pub source_data_version: Option<String>,
    pub mode: DistributionModeV1,
    pub y_columns: Vec<DistributionColumnRefV1>,
    pub weight_column_id: Option<String>,
    pub frequency_column_id: Option<String>,
    pub by_column_ids: Vec<String>,
    pub filter_expr: FilterExprV1,
    pub observation_policy: ObservationContributionPolicyV1,
    pub resource_budget: ResourceBudgetV1,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionChartKindV1 {
    HistogramData,
    BoxPlotData,
    QqData,
    PpData,
    CdfData,
    FittedCurveData,
    DiagnosticCoordinateData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionChartProvenanceV1 {
    pub method_id: String,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramBinV1 {
    pub lower: f64,
    pub upper: f64,
    pub count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxPlotCoordinatesV1 {
    pub lower_whisker: f64,
    pub lower_quartile: f64,
    pub median: f64,
    pub upper_quartile: f64,
    pub upper_whisker: f64,
    pub outliers: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionCoordinateV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DistributionChartDataV1 {
    HistogramData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        bins: Vec<HistogramBinV1>,
    },
    BoxPlotData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        coordinates: BoxPlotCoordinatesV1,
    },
    QqData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    PpData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    CdfData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    FittedCurveData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
    DiagnosticCoordinateData {
        schema_version: DistributionSchemaVersionV1,
        provenance: DistributionChartProvenanceV1,
        points: Vec<DistributionCoordinateV1>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionReportBlockV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub block_id: String,
    pub kind: String,
    pub title_key: String,
    pub status: String,
    pub chart_data: Option<DistributionChartDataV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptorV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub capability_id: String,
    pub method_spec_version: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionWorkspaceBootstrapV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub mode: DistributionModeV1,
    pub can_run: bool,
    pub dataset_count: usize,
    pub capabilities: Vec<CapabilityDescriptorV1>,
    pub observation_policy: ObservationContributionPolicyV1,
    pub resource_budget: ResourceBudgetV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum BlackBoxValueV1 {
    Number(f64),
    Boolean(bool),
    Code(String),
    NumberList(Vec<f64>),
    CodeList(Vec<String>),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BlackBoxObservationV1 {
    Numeric {
        output_id: String,
        value: f64,
    },
    Enumeration {
        output_id: String,
        value: String,
    },
    Status {
        output_id: String,
        value: BlackBoxStatusV1,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlackBoxStatusV1 {
    Available,
    Unavailable,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlackBoxProvenanceV1 {
    pub tool_version: String,
    pub input_hash: String,
    pub output_hash: String,
    pub legal_review_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlackBoxCaseV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub case_id: String,
    pub action_id: String,
    pub parameters: BTreeMap<String, BlackBoxValueV1>,
    pub observations: Vec<BlackBoxObservationV1>,
    pub warning_codes: Vec<String>,
    pub provenance: BlackBoxProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLedgerEntryV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub source_id: String,
    pub source_kind: String,
    pub review_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegalReviewRecordV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub record_id: String,
    pub artifact_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionLoadStatusV1 {
    #[default]
    Ready,
    UnknownVersion,
    MissingSource,
    Corrupt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionIssueV1 {
    pub analysis_id: String,
    pub kind: DistributionLoadStatusV1,
    pub message_key: String,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dataset_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distribution_request_v1_serializes_camel_case_and_versioned_filter_ast() {
        let request = DistributionRequestV1 {
            schema_version: "1".to_string(),
            analysis_id: "dist-001".to_string(),
            config_revision: 7,
            run_id: "run-abc".to_string(),
            source_dataset_id: Some("ds-42".to_string()),
            source_data_version: Some("17".to_string()),
            mode: DistributionModeV1::Continuous,
            y_columns: vec![DistributionColumnRefV1 {
                column_id: "sales-amount-id".to_string(),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: Some("sample-weight-id".to_string()),
            frequency_column_id: None,
            by_column_ids: vec!["region-id".to_string()],
            filter_expr: FilterExprV1::And {
                exprs: vec![FilterExprV1::CategorySet {
                    field_id: "region".to_string(),
                    values: vec!["East".to_string()],
                    negate: false,
                }],
            },
            observation_policy: ObservationContributionPolicyV1::strict_v1()
                .expect("load strict observation policy"),
            resource_budget: ResourceBudgetV1 {
                max_groups: 1_000,
                max_rows_per_group: 100_000,
                max_total_rows: 1_000_000,
                max_total_bytes: 64 * 1024 * 1024,
                cancel_token: Some("cancel-1".to_string()),
            },
            exact: true,
        };

        let json = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(json["analysisId"], "dist-001");
        assert_eq!(json["configRevision"], 7);
        assert_eq!(json["filterExpr"]["kind"], "and");
        assert_eq!(json["filterExpr"]["exprs"][0]["kind"], "categorySet");
    }

    #[test]
    fn strict_observation_policy_covers_every_phase_zero_dimension() {
        let policy =
            ObservationContributionPolicyV1::strict_v1().expect("load strict observation policy");
        let actual = policy
            .dimensions
            .iter()
            .map(|dimension| dimension.code.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "yMissing",
            "weightMissing",
            "weightZero",
            "weightNegative",
            "weightNonFinite",
            "frequencyMissing",
            "frequencyZero",
            "frequencyNegative",
            "frequencyNonInteger",
            "frequencyNonFinite",
            "weightAndFrequency",
            "byMissing",
            "emptyGroup",
            "singleObservation",
            "constantColumn",
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(actual, expected);
    }

    #[test]
    fn distribution_chart_kind_v1_is_closed_and_payloads_are_precomputed() {
        let kinds = [
            DistributionChartKindV1::HistogramData,
            DistributionChartKindV1::BoxPlotData,
            DistributionChartKindV1::QqData,
            DistributionChartKindV1::PpData,
            DistributionChartKindV1::CdfData,
            DistributionChartKindV1::FittedCurveData,
            DistributionChartKindV1::DiagnosticCoordinateData,
        ];
        let json = serde_json::to_value(kinds).expect("serialize chart kinds");
        assert_eq!(
            json,
            serde_json::json!([
                "histogramData",
                "boxPlotData",
                "qqData",
                "ppData",
                "cdfData",
                "fittedCurveData",
                "diagnosticCoordinateData"
            ])
        );

        let chart = DistributionChartDataV1::HistogramData {
            schema_version: "1".to_string(),
            provenance: DistributionChartProvenanceV1 {
                method_id: "histogram-v1".to_string(),
                snapshot_id: "snapshot-1".to_string(),
            },
            bins: vec![HistogramBinV1 {
                lower: 0.0,
                upper: 1.0,
                count: 3.0,
            }],
        };
        let serialized = serde_json::to_value(chart).expect("serialize chart data");
        assert_eq!(serialized["kind"], "histogramData");
        assert!(serialized.get("observations").is_none());
    }
}
