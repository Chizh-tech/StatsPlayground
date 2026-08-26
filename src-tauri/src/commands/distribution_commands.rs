use tauri::State;

use crate::error::AppError;
use crate::models::distribution::{
    BlackBoxCaseV1, CapabilityDescriptorV1, DistributionWorkspaceBootstrapV1,
};
use crate::services::distribution_service::DistributionService;
use crate::state::AppState;

#[tauri::command]
pub fn bootstrap_distribution_workspace(
    state: State<'_, AppState>,
) -> Result<DistributionWorkspaceBootstrapV1, AppError> {
    DistributionService::new(&state).bootstrap_distribution_workspace()
}

#[tauri::command]
pub fn list_distribution_capabilities(
    state: State<'_, AppState>,
) -> Result<Vec<CapabilityDescriptorV1>, AppError> {
    DistributionService::new(&state).list_distribution_capabilities()
}

#[tauri::command]
pub fn validate_black_box_case(
    state: State<'_, AppState>,
    case: BlackBoxCaseV1,
) -> Result<(), AppError> {
    DistributionService::new(&state).validate_black_box_case(&case)
}
