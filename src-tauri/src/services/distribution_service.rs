use crate::error::AppError;
use std::hash::{Hash, Hasher};

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
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        columns.hash(&mut hasher);
        Ok((generation, format!("schema:{:016x}", hasher.finish())))
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
        expected_token: &str,
    ) -> Result<(), AppError> {
        if token.cancel_token != expected_token || token.cancel_token != state.cancel_token {
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
        if case.case_id.trim().is_empty() || case.action_id.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "black-box case and action IDs must be provided".to_string(),
            ));
        }
        if case.provenance.tool_version.trim().is_empty()
            || case.provenance.input_hash.trim().is_empty()
            || case.provenance.output_hash.trim().is_empty()
            || case.provenance.legal_review_status.trim().is_empty()
        {
            return Err(AppError::InvalidParam(
                "black-box provenance is incomplete".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(DistributionService::cancel_run(&mut state, &token, "different").is_err());
        DistributionService::cancel_run(&mut state, &token, "opaque:/not-interpreted")
            .expect("cancel");
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
}
