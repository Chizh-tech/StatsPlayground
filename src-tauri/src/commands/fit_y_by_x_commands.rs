use crate::error::AppError;
use crate::models::fit_y_by_x::{FitYByXRequest, FitYByXResult};
use crate::services::fit_y_by_x_service::FitYByXService;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn fit_y_by_x(
    state: State<'_, AppState>,
    request: FitYByXRequest,
) -> Result<FitYByXResult, AppError> {
    FitYByXService::new(&state).run(request)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::models::fit_y_by_x::{
        FitYByXNotComputableReason, FitYByXPersonality, FitYByXRequest, FitYByXResult,
        NotComputableResult,
    };

    use super::fit_y_by_x;

    #[test]
    fn command_signature_is_request_to_result_delegate() {
        let source = include_str!("fit_y_by_x_commands.rs");
        let start = source
            .find("pub fn fit_y_by_x(")
            .expect("fit_y_by_x command must exist");
        let signature = &source[start
            ..source[start..]
                .find(") ->")
                .map(|offset| start + offset + 1)
                .expect("fit_y_by_x command signature must include return type")];

        assert!(signature.contains("state: State<'_, AppState>"));
        assert!(signature.contains("request: FitYByXRequest"));
        assert!(source.contains("FitYByXService::new(&state).run(request)"));
    }

    #[test]
    fn request_and_result_use_camel_case_ipc_shape() {
        let _command = fit_y_by_x;
        let request: FitYByXRequest = serde_json::from_value(json!({
            "datasetId": "ds1",
            "generation": 7,
            "responseColumn": "height",
            "factorColumn": "site",
            "personality": "oneway",
            "confidenceLevel": 0.95
        }))
        .expect("request should deserialize");

        assert_eq!(request.generation, 7);
        assert_eq!(request.personality, FitYByXPersonality::Oneway);

        let value = serde_json::to_value(FitYByXResult::NotComputable(NotComputableResult {
            personality: FitYByXPersonality::Bivariate,
            reason: FitYByXNotComputableReason::ConstantFactor,
            used_rows: 3,
            excluded_rows: 2,
            confidence_level: 0.95,
        }))
        .expect("response should serialize");

        assert_eq!(value["kind"], "notComputable");
        assert_eq!(value["usedRows"], 3);
        assert_eq!(value["excludedRows"], 2);
        assert_eq!(value["confidenceLevel"], 0.95);
        assert_eq!(value["personality"], "bivariate");
        assert_eq!(value["reason"], "constantFactor");
    }
}
