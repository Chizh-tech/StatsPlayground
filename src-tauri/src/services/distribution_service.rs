use crate::error::AppError;
use sha2::{Digest, Sha256};

use crate::models::distribution::{
    AnalysisSnapshotV1, BlackBoxCaseV1, CapabilityDescriptorV1, DistributionCancelTokenV1,
    DistributionModeV1, DistributionProgressV1, DistributionRunStateV1,
    DistributionRunStatusV1, DistributionWorkspaceBootstrapV1,
    ObservationContributionPolicyV1, ResourceBudgetV1,
};
use crate::services::data_service::DataService;
use crate::state::AppState;

pub struct DistributionService<'a> {
    state: &'a AppState,
}

impl<'a> DistributionService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn bootstrap_distribution_workspace(
        &self,
    ) -> Result<DistributionWorkspaceBootstrapV1, AppError> {
        let dataset_count = DataService::new(self.state).list_datasets()?.len();
        Ok(DistributionWorkspaceBootstrapV1 {
            schema_version: "1".to_string(),
            mode: DistributionModeV1::EmptySystem,
            can_run: false,
            dataset_count,
            capabilities: self.list_distribution_capabilities()?,
            observation_policy: ObservationContributionPolicyV1::strict_v1()?,
            resource_budget: ResourceBudgetV1::default(),
        })
    }

    pub fn list_distribution_capabilities(&self) -> Result<Vec<CapabilityDescriptorV1>, AppError> {
        Ok(Vec::new())
    }

    pub fn take_analysis_snapshot(
        &self,
        analysis_id: &str,
        dataset_id: &str,
        filter_fingerprint: &str,
    ) -> Result<AnalysisSnapshotV1, AppError> {
        let (generation, schema_fingerprint) = self.current_dataset_identity(dataset_id)?;
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| AppError::InvalidParam(format!("invalid system clock: {error}")))?
            .as_millis()
            .to_string();
        Ok(AnalysisSnapshotV1 {
            schema_version: "1".to_string(),
            analysis_id: analysis_id.to_string(),
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            dataset_id: dataset_id.to_string(),
            source_data_version: generation.to_string(),
            dataset_generation: generation,
            schema_fingerprint,
            filter_fingerprint: filter_fingerprint.to_string(),
            created_at,
        })
    }

    pub fn validate_snapshot_is_current(
        &self,
        snapshot: &AnalysisSnapshotV1,
        filter_fingerprint: &str,
    ) -> Result<(), AppError> {
        let (generation, schema_fingerprint) = self.current_dataset_identity(&snapshot.dataset_id)?;
        if generation != snapshot.dataset_generation
            || schema_fingerprint != snapshot.schema_fingerprint
            || filter_fingerprint != snapshot.filter_fingerprint
        {
            return Err(AppError::InvalidParam("stale analysis snapshot".to_string()));
        }
        Ok(())
    }

    fn current_dataset_identity(&self, dataset_id: &str) -> Result<(u64, String), AppError> {
        let db = self
            .state
            .db
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let generation = db.get_dataset_generation(dataset_id)?;
        let columns = db.get_user_columns(dataset_id)?;
        Ok((generation, schema_fingerprint(&columns)?))
    }

    pub fn emit_progress(
        state: &mut DistributionRunStateV1,
        phase: &str,
        current: u64,
        total: u64,
        message_key: &str,
    ) -> Result<(), AppError> {
        if total == 0 || current > total {
            return Err(AppError::InvalidParam("invalid progress bounds".to_string()));
        }
        let percent = current as f64 * 100.0 / total as f64;
        if state.progress.as_ref().is_some_and(|previous| {
            current < previous.current || percent < previous.percent
        }) {
            return Err(AppError::InvalidParam("progress must be monotonic".to_string()));
        }
        state.progress = Some(DistributionProgressV1 {
            run_id: state.run_id.clone(),
            phase: phase.to_string(),
            current,
            total,
            message_key: message_key.to_string(),
            percent,
        });
        Ok(())
    }

    pub fn cancel_run(
        state: &mut DistributionRunStateV1,
        token: &DistributionCancelTokenV1,
    ) -> Result<(), AppError> {
        if token.cancel_token != state.cancel_token {
            return Err(AppError::InvalidParam("cancel token mismatch".to_string()));
        }
        state.status = DistributionRunStatusV1::Cancelled;
        Ok(())
    }

    pub fn validate_black_box_case(&self, case: &BlackBoxCaseV1) -> Result<(), AppError> {
        if case.schema_version != "1" {
            return Err(AppError::InvalidParam(
                "unsupported black-box case schema version".to_string(),
            ));
        }
        if !is_machine_id(&case.case_id) || !is_machine_id(&case.action_id) {
            return Err(AppError::InvalidParam(
                "black-box case and action IDs must be machine-readable".to_string(),
            ));
        }
        let provenance = &case.provenance;
        if !is_sha256(&provenance.source_ledger_hash)
            || !is_sha256(&provenance.input_hash)
            || !is_sha256(&provenance.output_hash)
            || !is_sha256(&provenance.review_artifact_hash)
            || !is_machine_id(&provenance.tool_version)
            || !is_machine_id(&provenance.seed)
        {
            return Err(AppError::InvalidParam(
                "black-box provenance is incomplete".to_string(),
            ));
        }
        for (key, value) in &case.inputs {
            if !is_machine_id(key) || !black_box_value_is_sanitized(value) {
                return Err(AppError::InvalidParam(
                    "black-box inputs must be structured machine values".to_string(),
                ));
            }
        }
        for observation in case.expected.iter().chain(&case.observed) {
            if !black_box_observation_is_sanitized(observation) {
                return Err(AppError::InvalidParam(
                    "black-box observations must be structured machine values".to_string(),
                ));
            }
        }
        if case.warnings.iter().any(|warning| !is_machine_id(warning)) {
            return Err(AppError::InvalidParam(
                "black-box warnings must be machine-readable codes".to_string(),
            ));
        }
        Ok(())
    }
}

fn schema_fingerprint(columns: &[(String, String)]) -> Result<String, AppError> {
    let canonical = serde_json::to_vec(columns)
        .map_err(|error| AppError::InvalidParam(format!("invalid schema: {error}")))?;
    let digest = Sha256::digest(canonical);
    Ok(format!("schema:sha256:{digest:x}"))
}

fn is_machine_id(value: &str) -> bool {
    if value.is_empty() || std::path::Path::new(value).is_absolute() {
        return false;
    }
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        })
}

fn is_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hash| hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit()))
}

fn black_box_value_is_sanitized(value: &crate::models::distribution::BlackBoxValueV1) -> bool {
    use crate::models::distribution::BlackBoxValueV1;
    match value {
        BlackBoxValueV1::Number(number) => number.is_finite(),
        BlackBoxValueV1::Boolean(_) | BlackBoxValueV1::Null => true,
        BlackBoxValueV1::Code(code) => is_machine_id(code),
        BlackBoxValueV1::NumberList(values) => values.iter().all(|value| value.is_finite()),
        BlackBoxValueV1::CodeList(values) => values.iter().all(|value| is_machine_id(value)),
    }
}

fn black_box_observation_is_sanitized(
    observation: &crate::models::distribution::BlackBoxObservationV1,
) -> bool {
    use crate::models::distribution::BlackBoxObservationV1;
    match observation {
        BlackBoxObservationV1::Numeric { output_id, value } => {
            is_machine_id(output_id) && value.is_finite()
        }
        BlackBoxObservationV1::Enumeration { output_id, value } => {
            is_machine_id(output_id) && is_machine_id(value)
        }
        BlackBoxObservationV1::Status { output_id, .. } => is_machine_id(output_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::distribution::{
        BlackBoxObservationV1, BlackBoxProvenanceV1, BlackBoxStatusV1, BlackBoxValueV1,
    };
    use crate::services::data_service::DataService;

    #[test]
    fn bootstrap_distribution_workspace_returns_empty_system_path() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let bootstrap = service
            .bootstrap_distribution_workspace()
            .expect("bootstrap");

        assert!(!bootstrap.can_run);
        assert!(bootstrap.capabilities.is_empty());
        assert_eq!(bootstrap.mode, DistributionModeV1::EmptySystem);
        assert_eq!(bootstrap.observation_policy.schema_version, "1");
    }

    #[test]
    fn stale_snapshot_is_rejected_after_generation_change() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table("Snapshot", &["value".into()], &["DOUBLE".into()])
            .expect("create dataset");
        let service = DistributionService::new(&state);
        let snapshot = service
            .take_analysis_snapshot("dist-1", &dataset.id, "filter:v1")
            .expect("snapshot");

        data.add_row(&dataset.id).expect("mutate dataset");

        assert!(service
            .validate_snapshot_is_current(&snapshot, "filter:v1")
            .is_err());
    }

    #[test]
    fn concurrent_mutation_marks_previous_run_stale() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table("Concurrent", &["value".into()], &["DOUBLE".into()])
            .expect("create dataset");
        let service = DistributionService::new(&state);
        let snapshot = service
            .take_analysis_snapshot("dist-1", &dataset.id, "filter:v1")
            .expect("snapshot");

        std::thread::scope(|scope| {
            scope.spawn(|| data.add_row(&dataset.id).expect("concurrent mutation"));
        });

        assert!(service
            .validate_snapshot_is_current(&snapshot, "filter:v1")
            .is_err());
    }

    #[test]
    fn progress_is_monotonic_and_cancel_token_is_opaque() {
        let mut state =
            DistributionRunStateV1::running("run-1", "snapshot-1", "opaque:/not-interpreted");
        DistributionService::emit_progress(&mut state, "prepare", 2, 10, "distribution.prepare")
            .expect("first progress");
        DistributionService::emit_progress(&mut state, "prepare", 8, 10, "distribution.prepare")
            .expect("second progress");
        assert!(DistributionService::emit_progress(
            &mut state,
            "prepare",
            7,
            10,
            "distribution.prepare"
        )
        .is_err());
        assert_eq!(state.progress.as_ref().expect("progress").percent, 80.0);

        let token = DistributionCancelTokenV1 {
            cancel_token: "opaque:/not-interpreted".to_string(),
        };
        let wrong_token = DistributionCancelTokenV1 {
            cancel_token: "different".to_string(),
        };
        assert!(DistributionService::cancel_run(&mut state, &wrong_token).is_err());
        DistributionService::cancel_run(&mut state, &token).expect("cancel");
        assert_eq!(state.status, DistributionRunStatusV1::Cancelled);
    }

    #[test]
    fn changed_filter_fingerprint_rejects_snapshot() {
        let state = AppState::new().expect("test state");
        let data = DataService::new(&state);
        let dataset = data
            .create_table("Filter", &["value".into()], &["DOUBLE".into()])
            .expect("create dataset");
        let service = DistributionService::new(&state);
        let snapshot = service
            .take_analysis_snapshot("dist-1", &dataset.id, "filter:v1")
            .expect("snapshot");

        assert!(service
            .validate_snapshot_is_current(&snapshot, "filter:v2")
            .is_err());
    }

    #[test]
    fn schema_fingerprint_is_canonical_sha256() {
        let columns = vec![("value".to_string(), "DOUBLE".to_string())];
        assert_eq!(
            schema_fingerprint(&columns).expect("fingerprint"),
            "schema:sha256:2f6ce0b14f1e3607f4c670257550863187ce940cc0d6c78254f9ec3ff7ecf193"
        );
    }

    fn synthetic_black_box_case() -> BlackBoxCaseV1 {
        BlackBoxCaseV1 {
            schema_version: "1".to_string(),
            case_id: "case.synthetic.001".to_string(),
            action_id: "distribution.synthetic.summary".to_string(),
            provenance: BlackBoxProvenanceV1 {
                source_ledger_hash: format!("sha256:{}", "1".repeat(64)),
                input_hash: format!("sha256:{}", "2".repeat(64)),
                output_hash: format!("sha256:{}", "3".repeat(64)),
                tool_version: "validator.v1".to_string(),
                seed: "seed.synthetic.001".to_string(),
                review_artifact_hash: format!("sha256:{}", "4".repeat(64)),
            },
            inputs: std::collections::BTreeMap::from([(
                "parameter.alpha".to_string(),
                BlackBoxValueV1::Number(0.05),
            )]),
            expected: vec![BlackBoxObservationV1::Status {
                output_id: "result.status".to_string(),
                value: BlackBoxStatusV1::Available,
            }],
            observed: vec![BlackBoxObservationV1::Numeric {
                output_id: "result.value".to_string(),
                value: 1.25,
            }],
            warnings: vec!["warning.synthetic.none".to_string()],
        }
    }

    #[test]
    fn capability_registry_exposes_only_implemented_methods() {
        let state = AppState::new().expect("test state");
        let capabilities = DistributionService::new(&state)
            .list_distribution_capabilities()
            .expect("capabilities");

        assert!(capabilities.is_empty());
        assert!(!capabilities
            .iter()
            .any(|capability| capability.id.contains("future")));
    }

    #[test]
    fn black_box_case_validator_rejects_free_text_and_paths() {
        let state = AppState::new().expect("test state");
        let service = DistributionService::new(&state);
        let valid = synthetic_black_box_case();
        service.validate_black_box_case(&valid).expect("valid case");

        let mut free_text = valid.clone();
        free_text.observed = vec![BlackBoxObservationV1::Enumeration {
            output_id: "result.label".to_string(),
            value: "a copied product sentence".to_string(),
        }];
        assert!(service.validate_black_box_case(&free_text).is_err());

        let mut absolute_path = valid.clone();
        absolute_path.action_id = "C:\\private\\capture.png".to_string();
        assert!(service.validate_black_box_case(&absolute_path).is_err());

        let mut missing_hash = valid;
        missing_hash.provenance.output_hash.clear();
        assert!(service.validate_black_box_case(&missing_hash).is_err());

        let mut malformed_hash = synthetic_black_box_case();
        malformed_hash.provenance.input_hash = "sha256:not-hex".to_string();
        assert!(service.validate_black_box_case(&malformed_hash).is_err());

        let mut relative_screenshot = synthetic_black_box_case();
        relative_screenshot.action_id = "screenshots/capture.png".to_string();
        assert!(service
            .validate_black_box_case(&relative_screenshot)
            .is_err());

        let mut invalid_seed = synthetic_black_box_case();
        invalid_seed.provenance.seed = "seed with spaces".to_string();
        assert!(service.validate_black_box_case(&invalid_seed).is_err());
    }
}
