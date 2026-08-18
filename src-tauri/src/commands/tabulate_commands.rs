use tauri::State;

use crate::error::AppError;
use crate::models::tabulate::{TabulateRequest, TabulateResult};
use crate::services::tabulate_service::TabulateService;
use crate::state::AppState;

#[tauri::command]
pub fn tabulate(
    state: State<'_, AppState>,
    request: TabulateRequest,
) -> Result<TabulateResult, AppError> {
    TabulateService::new(&state).run(request)
}

#[cfg(test)]
mod tests {
    use crate::models::tabulate::{
        StatisticKind, TabulateRequest, TabulateResult, TabulateStatistic,
    };

    #[test]
    fn tabulate_contract_serializes_camel_case_fields_and_enum_values() {
        let request = TabulateRequest {
            dataset_id: "dataset-1".into(),
            row_fields: vec!["region".into()],
            column_fields: vec!["product".into()],
            statistics: vec![TabulateStatistic {
                id: "std-dev-sales".into(),
                field: "sales".into(),
                kind: StatisticKind::StandardDeviation,
                quantile: None,
            }],
            include_row_totals: true,
            include_column_totals: false,
            max_result_cells: 10_000,
        };

        let request_json = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(request_json["datasetId"], "dataset-1");
        assert_eq!(request_json["rowFields"][0], "region");
        assert_eq!(request_json["columnFields"][0], "product");
        assert_eq!(request_json["includeRowTotals"], true);
        assert_eq!(request_json["includeColumnTotals"], false);
        assert_eq!(request_json["maxResultCells"], 10_000);
        assert_eq!(request_json["statistics"][0]["kind"], "standardDeviation");

        let result = TabulateResult {
            row_members: vec![vec![serde_json::json!("East")]],
            column_members: vec![vec![serde_json::json!("A")]],
            statistics: vec![TabulateStatistic {
                id: "std-dev-sales".into(),
                field: "sales".into(),
                kind: StatisticKind::StandardDeviation,
                quantile: None,
            }],
            cells: vec![Some(1.5)],
            row_totals: vec![Some(1.5)],
            column_totals: vec![Some(1.5)],
            grand_totals: vec![Some(1.5)],
            cell_count: 1,
            limit: 10_000,
        };

        let result_json = serde_json::to_value(&result).expect("serialize result");
        assert_eq!(result_json["rowMembers"][0][0], "East");
        assert_eq!(result_json["columnMembers"][0][0], "A");
        assert_eq!(result_json["cells"][0], 1.5);
        assert_eq!(result_json["cellCount"], 1);
        assert_eq!(result_json["limit"], 10_000);
        assert_eq!(result_json["statistics"][0]["kind"], "standardDeviation");
    }
}
