use crate::error::AppError;
use crate::models::distribution::{
    BlackBoxCaseV1, CapabilityDescriptorV1, DistributionModeV1, DistributionWorkspaceBootstrapV1,
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
}
