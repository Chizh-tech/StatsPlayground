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
    DateTime,
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
    pub analysis_id: String,
    pub snapshot_id: String,
    pub dataset_id: String,
    pub source_data_version: String,
    pub dataset_generation: u64,
    pub schema_fingerprint: String,
    pub filter_fingerprint: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionProgressV1 {
    pub run_id: String,
    pub phase: String,
    pub current: u64,
    pub total: u64,
    pub message_key: String,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionCancelTokenV1 {
    pub cancel_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DistributionRunStatusV1 {
    Running,
    Completed,
    Cancelled,
    Stale,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRunStateV1 {
    pub run_id: String,
    pub status: DistributionRunStatusV1,
    pub progress: Option<DistributionProgressV1>,
    pub snapshot_id: String,
    pub cancel_token: String,
}

impl DistributionRunStateV1 {
    pub fn running(run_id: &str, snapshot_id: &str, cancel_token: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            status: DistributionRunStatusV1::Running,
            progress: None,
            snapshot_id: snapshot_id.to_string(),
            cancel_token: cancel_token.to_string(),
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityOverrideEnvelopeV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub capability_id: String,
    pub payload_schema_version: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionAnalysisConfigV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub source_dataset_id: String,
    pub y_columns: Vec<DistributionColumnRefV1>,
    pub weight_column_id: Option<String>,
    pub frequency_column_id: Option<String>,
    pub by_column_ids: Vec<String>,
    pub filter_expr: FilterExprV1,
    pub confidence_level: f64,
    pub histograms_only: bool,
    pub enabled_capability_ids: Vec<String>,
    pub capability_overrides: Vec<CapabilityOverrideEnvelopeV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionConfigErrorV1 {
    pub code: String,
    pub message_key: String,
    pub field_path: String,
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
    pub id: String,
    pub title_key: String,
    pub scope: String,
    pub menu_scope: String,
    pub status_key: String,
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
    pub source_ledger_hash: String,
    pub input_hash: String,
    pub output_hash: String,
    pub tool_version: String,
    pub seed: String,
    pub review_artifact_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlackBoxCaseV1 {
    pub schema_version: DistributionSchemaVersionV1,
    pub case_id: String,
    pub action_id: String,
    pub provenance: BlackBoxProvenanceV1,
    pub inputs: BTreeMap<String, BlackBoxValueV1>,
    pub expected: Vec<BlackBoxObservationV1>,
    pub observed: Vec<BlackBoxObservationV1>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLedgerEntryV1 {
    pub artifact_id: String,
    pub origin_kind: String,
    pub allowed_field_keys: Vec<String>,
    pub input_hash: String,
    pub output_hash: String,
    pub review_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegalReviewRecordV1 {
    pub artifact_id: String,
    pub status: String,
    pub requested_at: String,
    pub reviewer_role: String,
    pub artifact_hash: String,
    pub notes_hash: String,
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
    use proptest::prelude::*;
    use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

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
    fn analysis_config_v1_serializes_roles_and_overrides_in_camel_case() {
        let config = DistributionAnalysisConfigV1 {
            schema_version: "1".to_string(),
            source_dataset_id: "dataset-1".to_string(),
            y_columns: vec![DistributionColumnRefV1 {
                column_id: "col-y".to_string(),
                modeling_type: DistributionModelingTypeV1::Continuous,
            }],
            weight_column_id: Some("col-weight".to_string()),
            frequency_column_id: Some("col-freq".to_string()),
            by_column_ids: vec!["col-date".to_string()],
            filter_expr: FilterExprV1::IsNull {
                field_id: "col-group".to_string(),
                negate: true,
            },
            confidence_level: 0.95,
            histograms_only: false,
            enabled_capability_ids: vec!["capability.synthetic".to_string()],
            capability_overrides: vec![CapabilityOverrideEnvelopeV1 {
                schema_version: "1".to_string(),
                capability_id: "capability.synthetic".to_string(),
                payload_schema_version: "1".to_string(),
                payload: serde_json::json!({ "enabled": true }),
            }],
        };

        let json = serde_json::to_value(config).expect("serialize analysis config");
        assert_eq!(json["sourceDatasetId"], "dataset-1");
        assert_eq!(json["confidenceLevel"], 0.95);
        assert_eq!(json["histogramsOnly"], false);
        assert_eq!(json["enabledCapabilityIds"][0], "capability.synthetic");
        assert_eq!(json["capabilityOverrides"][0]["payloadSchemaVersion"], "1");
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

    fn filter_expr_strategy() -> impl Strategy<Value = FilterExprV1> {
        let leaf = prop_oneof![
            "[a-z]{1,8}".prop_map(|field_id| FilterExprV1::IsNull {
                field_id,
                negate: false,
            }),
            ("[a-z]{1,8}", -1_000_000i32..=1_000_000, -1_000_000i32..=1_000_000).prop_map(
                |(field_id, left, right)| FilterExprV1::NumericRange {
                    field_id,
                    min: Some(left.min(right) as f64),
                    max: Some(left.max(right) as f64),
                    include_min: true,
                    include_max: true,
                },
            ),
        ];
        leaf.prop_recursive(4, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|exprs| FilterExprV1::And { exprs }),
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|exprs| FilterExprV1::Or { exprs }),
                inner.prop_map(|expr| FilterExprV1::Not { expr: Box::new(expr) }),
            ]
        })
    }

    #[test]
    fn filter_expr_v1_round_trips_with_deterministic_property_stream() {
        let config = Config { cases: 128, ..Config::default() };
        let rng = TestRng::deterministic_rng(RngAlgorithm::ChaCha);
        let mut runner = TestRunner::new_with_rng(config, rng);
        runner
            .run(&filter_expr_strategy(), |expr| {
                let json = serde_json::to_string(&expr).expect("serialize filter");
                let restored = serde_json::from_str(&json).expect("deserialize filter");
                prop_assert_eq!(expr, restored);
                Ok(())
            })
            .expect("deterministic FilterExpr property test");
    }
}
