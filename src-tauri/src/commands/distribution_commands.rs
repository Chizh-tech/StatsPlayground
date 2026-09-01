use tauri::State;

use crate::error::AppError;
use crate::models::distribution::{
    BlackBoxCaseV1, CapabilityDescriptorV1, DistributionCancelTokenV1, DistributionRequestV1,
    DistributionResultEnvelopeV1, DistributionRunAcceptedV1, DistributionWorkspaceBootstrapV1,
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

#[tauri::command(async)]
pub fn start_distribution_run(
    state: State<'_, AppState>,
    request: DistributionRequestV1,
) -> Result<DistributionRunAcceptedV1, AppError> {
    DistributionService::new(&state).start_distribution_run(&request)
}

#[tauri::command(async)]
pub fn execute_distribution_run(
    state: State<'_, AppState>,
    request: DistributionRequestV1,
    accepted: DistributionRunAcceptedV1,
) -> Result<DistributionResultEnvelopeV1, AppError> {
    DistributionService::new(&state).execute_distribution_run(&request, &accepted)
}

#[tauri::command(async)]
pub fn cancel_distribution_run(
    state: State<'_, AppState>,
    token: DistributionCancelTokenV1,
) -> Result<(), AppError> {
    DistributionService::new(&state).cancel_distribution_run(&token)
}

#[cfg(test)]
mod tests {
    #[test]
    fn distribution_run_commands_use_async_command_scheduling() {
        let source = include_str!("distribution_commands.rs");

        for command in [
            "start_distribution_run",
            "execute_distribution_run",
            "cancel_distribution_run",
        ] {
            let command_offset = source
                .find(&format!("pub fn {command}"))
                .unwrap_or_else(|| panic!("missing {command}"));
            let command_attribute = &source[..command_offset];
            assert!(
                command_attribute
                    .trim_end()
                    .ends_with("#[tauri::command(async)]"),
                "{command} must use Tauri async command scheduling",
            );
        }
    }
}
