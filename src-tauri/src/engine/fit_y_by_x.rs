use std::collections::BTreeMap;

use nalgebra::{DMatrix, DVector};
use statrs::distribution::{ContinuousCDF, FisherSnedecor, StudentsT};

use crate::models::fit_y_by_x::{
    ActualByPredictedPoint, AnovaRow, BivariateResult, EffectSummaryRow, EstimateRow,
    FitYByXConstructModelEffects, FitYByXNotComputableReason, FitYByXPersonality, FitYByXResult,
    FitYByXRow,
    LackOfFitAvailable, LackOfFitResult, NotComputableResult, OnewayEffectSizes,
    OnewayGroupSummary, OnewayResult, PredictionProfilerPoint, ResidualByPredictedPoint,
    SummaryOfFit,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BivariateModelConfig {
    pub construct_model_effects: FitYByXConstructModelEffects,
    pub factorial_degree: Option<u8>,
    pub polynomial_degree: usize,
}


pub fn calculate_oneway(
    rows: Vec<FitYByXRow>,
    excluded_rows: u64,
    confidence_level: f64,
) -> FitYByXResult {
    let mut groups: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut used_rows = 0_u64;

    for row in rows {
        if let FitYByXRow::Oneway { y, group } = row {
            groups
                .entry(group)
                .or_default()
                .push(normalize_signed_zero(y));
            used_rows += 1;
        }
    }

    if used_rows == 0 {
        return not_computable(
            FitYByXPersonality::Oneway,
            FitYByXNotComputableReason::InsufficientValidRows,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    }

    if groups.len() < 2 {
        return not_computable(
            FitYByXPersonality::Oneway,
            FitYByXNotComputableReason::InsufficientGroups,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    }

    let total_groups = groups.len() as u64;
    let within_df = used_rows.saturating_sub(total_groups);

    let overall_mean = mean(groups.values().flat_map(|values| values.iter().copied()));

    let mut group_summaries = Vec::with_capacity(groups.len());
    let mut ss_between = 0.0_f64;
    let mut ss_within = 0.0_f64;

    for (group, values) in &groups {
        let count = values.len() as u64;
        let group_mean = mean(values.iter().copied());
        let centered_ss = centered_sum_of_squares(values.iter().copied(), group_mean);
        let standard_deviation = sample_standard_deviation(centered_ss, count);
        let standard_error =
            standard_deviation.map(|sd| normalize_signed_zero(sd / (count as f64).sqrt()));
        let (lower_confidence_limit, upper_confidence_limit) = confidence_interval(
            group_mean,
            standard_error,
            count.saturating_sub(1),
            confidence_level,
        );

        ss_between += (count as f64) * square(group_mean - overall_mean);
        ss_within += centered_ss;

        group_summaries.push(OnewayGroupSummary {
            group: group.clone(),
            count,
            mean: normalize_signed_zero(group_mean),
            standard_deviation,
            standard_error,
            lower_confidence_limit,
            upper_confidence_limit,
        });
    }

    let ss_total = normalize_small_zero(ss_between + ss_within);
    let between_df = total_groups - 1;
    let total_df = used_rows - 1;
    let ms_between = safe_divide(ss_between, between_df as f64);
    let ms_within = safe_divide(ss_within, within_df as f64);
    let f_ratio = match (ms_between, ms_within) {
        (Some(numerator), Some(denominator)) if denominator > 0.0 => {
            Some(normalize_signed_zero(numerator / denominator))
        }
        _ => None,
    };
    let p_value = f_ratio.and_then(|f| upper_tail_f(f, between_df, within_df));

    let eta_squared = if ss_total > 0.0 {
        normalize_signed_zero((ss_between / ss_total).clamp(0.0, 1.0))
    } else {
        0.0
    };
    let omega_squared = ms_within.and_then(|ms_within_value| {
        if ss_total > 0.0 {
            let denominator = ss_total + ms_within_value;
            if denominator <= 0.0 {
                None
            } else {
                let estimate = (ss_between - (between_df as f64) * ms_within_value) / denominator;
                Some(normalize_signed_zero(estimate.max(0.0)))
            }
        } else {
            Some(0.0)
        }
    });

    FitYByXResult::Oneway(OnewayResult {
        used_rows,
        excluded_rows,
        confidence_level,
        group_summaries,
        anova: vec![
            AnovaRow {
                source: "Between".into(),
                degrees_of_freedom: between_df,
                sum_of_squares: normalize_signed_zero(ss_between),
                mean_square: ms_between,
                f_ratio,
                p_value,
            },
            AnovaRow {
                source: "Within".into(),
                degrees_of_freedom: within_df,
                sum_of_squares: normalize_signed_zero(ss_within),
                mean_square: ms_within,
                f_ratio: None,
                p_value: None,
            },
            AnovaRow {
                source: "Total".into(),
                degrees_of_freedom: total_df,
                sum_of_squares: ss_total,
                mean_square: None,
                f_ratio: None,
                p_value: None,
            },
        ],
        effect_sizes: OnewayEffectSizes {
            eta_squared,
            omega_squared,
        },
    })
}

pub fn calculate_bivariate(
    rows: Vec<(f64, f64)>,
    excluded_rows: u64,
    confidence_level: f64,
    model: BivariateModelConfig,
) -> FitYByXResult {
    let used_rows = rows.len() as u64;
    let parameter_count = model.polynomial_degree + 1;
    if used_rows < parameter_count as u64 + 1 {
        return not_computable(
            FitYByXPersonality::Bivariate,
            FitYByXNotComputableReason::InsufficientValidRows,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    }

    let mean_y = mean(rows.iter().map(|(_, y)| *y));
    let response = rows.iter().map(|(_, y)| *y).collect::<Vec<_>>();
    let design = design_matrix(&rows, model.polynomial_degree);
    let solved = solve_ols(&design, &response);
    let Some(solved) = solved else {
        return not_computable(
            FitYByXPersonality::Bivariate,
            FitYByXNotComputableReason::ConstantFactor,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    };

    if solved.coefficients.len() < 2 {
        return not_computable(
            FitYByXPersonality::Bivariate,
            FitYByXNotComputableReason::ConstantFactor,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    }

    let residual_df = used_rows.saturating_sub(parameter_count as u64);
    if residual_df == 0 {
        return not_computable(
            FitYByXPersonality::Bivariate,
            FitYByXNotComputableReason::NoResidualDegreesOfFreedom,
            used_rows,
            excluded_rows,
            confidence_level,
        );
    }

    let intercept = normalize_signed_zero(solved.coefficients[0]);
    let slope = normalize_signed_zero(solved.coefficients[1]);
    let ss_total = normalize_small_zero(
        rows.iter()
            .map(|(_, y)| square(y - mean_y))
            .sum::<f64>(),
    );
    let ss_error = normalize_small_zero(solved.residuals.iter().map(|value| square(*value)).sum());
    let ss_model = normalize_small_zero((ss_total - ss_error).max(0.0));
    let model_df = parameter_count as u64 - 1;
    let ms_model = safe_divide(ss_model, model_df as f64);
    let ms_error = safe_divide(ss_error, residual_df as f64);
    let f_ratio = match (ms_model, ms_error) {
        (Some(numerator), Some(denominator)) if denominator > 0.0 => {
            Some(normalize_signed_zero(numerator / denominator))
        }
        _ => None,
    };
    let model_p_value = f_ratio.and_then(|f| upper_tail_f(f, model_df, residual_df));

    let root_mean_square_error = ms_error.map(|value| normalize_signed_zero(value.sqrt()));
    let r_squared = ratio_or_none(ss_model, ss_total).map(|value| value.clamp(0.0, 1.0));
    let adjusted_r_squared = r_squared.and_then(|value| {
        if used_rows > parameter_count as u64 {
            Some(normalize_signed_zero(
                1.0 - (1.0 - value) * ((used_rows - 1) as f64) / ((used_rows - parameter_count as u64) as f64),
            ))
        } else {
            None
        }
    });

    let parameter_estimates = parameter_estimates(
        &solved.coefficients,
        &solved.xtx_inverse_diagonal,
        model.polynomial_degree,
        root_mean_square_error,
        residual_df,
        confidence_level,
    );
    let effect_summary = effect_summary_from_estimates(&parameter_estimates);
    let (actual_by_predicted, residual_by_predicted) =
        regression_diagnostic_points(&rows, &solved.predicted);
    let prediction_profiler = prediction_profiler(&rows, &solved.coefficients, model.polynomial_degree);
    let lack_of_fit = lack_of_fit(&rows, &solved.predicted, ss_error, residual_df, parameter_count);

    FitYByXResult::Bivariate(BivariateResult {
        used_rows,
        excluded_rows,
        confidence_level,
        construct_model_effects: model.construct_model_effects,
        factorial_degree: model.factorial_degree,
        intercept,
        slope,
        summary_of_fit: SummaryOfFit {
            r_squared,
            adjusted_r_squared,
            root_mean_square_error,
            mean_of_response: normalize_signed_zero(mean_y),
            observation_count: used_rows,
        },
        lack_of_fit,
        anova: vec![
            AnovaRow {
                source: "Model".into(),
                degrees_of_freedom: model_df,
                sum_of_squares: ss_model,
                mean_square: ms_model,
                f_ratio,
                p_value: model_p_value,
            },
            AnovaRow {
                source: "Error".into(),
                degrees_of_freedom: residual_df,
                sum_of_squares: ss_error,
                mean_square: ms_error,
                f_ratio: None,
                p_value: None,
            },
            AnovaRow {
                source: "Total".into(),
                degrees_of_freedom: used_rows - 1,
                sum_of_squares: ss_total,
                mean_square: None,
                f_ratio: None,
                p_value: None,
            },
        ],
        parameter_estimates,
        effect_summary,
        actual_by_predicted,
        residual_by_predicted,
        prediction_profiler,
    })
}

fn effect_summary_from_estimates(rows: &[EstimateRow]) -> Vec<EffectSummaryRow> {
    rows.iter()
        .map(|row| EffectSummaryRow {
            term: row.term.clone(),
            estimate: row.estimate,
            standard_error: row.standard_error,
            t_ratio: row.t_ratio,
            p_value: row.p_value,
            is_significant: row.p_value.map(|value| value < 0.05),
        })
        .collect()
}

fn regression_diagnostic_points(
    rows: &[(f64, f64)],
    predicted: &[f64],
) -> (Vec<ActualByPredictedPoint>, Vec<ResidualByPredictedPoint>) {
    let mut actual_by_predicted = Vec::with_capacity(rows.len());
    let mut residual_by_predicted = Vec::with_capacity(rows.len());
    for ((_, y), predicted_value) in rows.iter().zip(predicted.iter()) {
        let predicted = normalize_signed_zero(*predicted_value);
        let residual = normalize_signed_zero(*y - predicted);
        actual_by_predicted.push(ActualByPredictedPoint {
            predicted,
            actual: normalize_signed_zero(*y),
        });
        residual_by_predicted.push(ResidualByPredictedPoint {
            predicted,
            residual,
        });
    }

    (
        sort_actual_by_predicted(actual_by_predicted),
        sort_residual_by_predicted(residual_by_predicted),
    )
}

fn sort_actual_by_predicted(
    mut rows: Vec<ActualByPredictedPoint>,
) -> Vec<ActualByPredictedPoint> {
    rows.sort_by(|left, right| {
        left.predicted
            .total_cmp(&right.predicted)
            .then_with(|| left.actual.total_cmp(&right.actual))
    });
    rows
}

fn sort_residual_by_predicted(
    mut rows: Vec<ResidualByPredictedPoint>,
) -> Vec<ResidualByPredictedPoint> {
    rows.sort_by(|left, right| {
        left.predicted
            .total_cmp(&right.predicted)
            .then_with(|| left.residual.total_cmp(&right.residual))
    });
    rows
}

fn prediction_profiler(
    rows: &[(f64, f64)],
    coefficients: &[f64],
    polynomial_degree: usize,
) -> Vec<PredictionProfilerPoint> {
    if rows.is_empty() {
        return Vec::new();
    }

    let mut x_values = rows.iter().map(|(x, _)| *x).collect::<Vec<_>>();
    x_values.sort_by(f64::total_cmp);
    let min = x_values[0];
    let max = x_values[x_values.len() - 1];
    let center = median(&x_values);

    let mut unique_points: Vec<(&str, f64)> = Vec::new();
    for candidate in [("Low", min), ("Center", center), ("High", max)] {
        if unique_points.iter().any(|(_, value)| {
            normalize_small_zero(*value - candidate.1) == 0.0
        }) {
            continue;
        }
        unique_points.push(candidate);
    }

    unique_points
        .into_iter()
        .map(|(label, factor_value)| PredictionProfilerPoint {
            label: label.into(),
            factor_value: normalize_signed_zero(factor_value),
            predicted_response: normalize_signed_zero(predict_polynomial(
                coefficients,
                factor_value,
                polynomial_degree,
            )),
        })
        .collect()
}

fn median(sorted_values: &[f64]) -> f64 {
    let length = sorted_values.len();
    if length % 2 == 1 {
        sorted_values[length / 2]
    } else {
        normalize_signed_zero((sorted_values[length / 2 - 1] + sorted_values[length / 2]) / 2.0)
    }

    #[derive(Debug, Clone)]
    struct OlsSolved {
        coefficients: Vec<f64>,
        predicted: Vec<f64>,
        residuals: Vec<f64>,
        xtx_inverse_diagonal: Vec<f64>,
    }

    fn design_matrix(rows: &[(f64, f64)], polynomial_degree: usize) -> Vec<Vec<f64>> {
        rows.iter()
            .map(|(x, _)| {
                let mut row = Vec::with_capacity(polynomial_degree + 1);
                row.push(1.0);
                for degree in 1..=polynomial_degree {
                    row.push(x.powi(degree as i32));
                }
                row
            })
            .collect()
    }

    fn solve_ols(design: &[Vec<f64>], response: &[f64]) -> Option<OlsSolved> {
        if design.is_empty() || response.is_empty() || design.len() != response.len() {
            return None;
        }
        let row_count = design.len();
        let column_count = design[0].len();
        if column_count == 0 || design.iter().any(|row| row.len() != column_count) {
            return None;
        }

        let flattened = design.iter().flatten().copied().collect::<Vec<_>>();
        let x = DMatrix::from_row_slice(row_count, column_count, &flattened);
        let y = DVector::from_row_slice(response);
        let xtx = x.transpose() * &x;
        let xtx_inverse = xtx.try_inverse()?;
        let beta = &xtx_inverse * x.transpose() * &y;
        let fitted = x * &beta;
        let residual = y - &fitted;
        let xtx_inverse_diagonal = (0..column_count)
            .map(|index| normalize_signed_zero(xtx_inverse[(index, index)]))
            .collect::<Vec<_>>();

        Some(OlsSolved {
            coefficients: beta.iter().map(|value| normalize_signed_zero(*value)).collect(),
            predicted: fitted
                .iter()
                .map(|value| normalize_signed_zero(*value))
                .collect(),
            residuals: residual
                .iter()
                .map(|value| normalize_signed_zero(*value))
                .collect(),
            xtx_inverse_diagonal,
        })
    }

    fn predict_polynomial(coefficients: &[f64], x: f64, polynomial_degree: usize) -> f64 {
        coefficients
            .iter()
            .enumerate()
            .take(polynomial_degree + 1)
            .map(|(degree, coefficient)| coefficient * x.powi(degree as i32))
            .sum()
    }
}

fn parameter_estimates(
    coefficients: &[f64],
    xtx_inverse_diagonal: &[f64],
    polynomial_degree: usize,
    root_mean_square_error: Option<f64>,
    residual_df: u64,
    confidence_level: f64,
) -> Vec<EstimateRow> {
    let maybe_scale = root_mean_square_error
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(square);
    let maybe_t_critical = t_critical(residual_df, confidence_level);
    coefficients
        .iter()
        .enumerate()
        .map(|(index, estimate)| {
            let standard_error = match (maybe_scale, xtx_inverse_diagonal.get(index).copied()) {
                (Some(mse), Some(variance_scale)) if variance_scale >= 0.0 => {
                    Some(normalize_signed_zero((mse * variance_scale).sqrt()))
                }
                _ => None,
            };
            estimate_row(
                coefficient_term_name(index, polynomial_degree),
                *estimate,
                standard_error,
                residual_df,
                maybe_t_critical,
            )
        })
        .collect()
}

fn coefficient_term_name(index: usize, polynomial_degree: usize) -> &'static str {
    if index == 0 {
        return "Intercept";
    }
    if polynomial_degree == 1 && index == 1 {
        return "Slope";
    }
    if index == 1 {
        return "Linear";
    }
    if index == 2 {
        return "Quadratic";
    }
    "Term"
}

fn estimate_row(
    term: &str,
    estimate: f64,
    standard_error: Option<f64>,
    residual_df: u64,
    maybe_t_critical: Option<f64>,
) -> EstimateRow {
    let t_ratio = match standard_error {
        Some(standard_error_value) if standard_error_value > 0.0 => {
            Some(normalize_signed_zero(estimate / standard_error_value))
        }
        _ => None,
    };
    let p_value = t_ratio.and_then(|value| two_sided_t_p_value(value, residual_df));
    let (lower_confidence_limit, upper_confidence_limit) = match (standard_error, maybe_t_critical)
    {
        (Some(standard_error_value), Some(t_value)) => {
            let margin = t_value * standard_error_value;
            (
                Some(normalize_signed_zero(estimate - margin)),
                Some(normalize_signed_zero(estimate + margin)),
            )
        }
        _ => (None, None),
    };

    EstimateRow {
        term: term.into(),
        estimate: normalize_signed_zero(estimate),
        standard_error,
        t_ratio,
        p_value,
        lower_confidence_limit,
        upper_confidence_limit,
    }
}

fn lack_of_fit(
    rows: &[(f64, f64)],
    predicted: &[f64],
    ss_error: f64,
    residual_df: u64,
    parameter_count: usize,
) -> LackOfFitResult {
    let mut groups: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    let mut sorted = rows
        .iter()
        .zip(predicted.iter())
        .map(|((x, y), fitted)| (*x, *y, *fitted))
        .collect::<Vec<_>>();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));

    for (x, y, fitted) in sorted {
        match groups.last_mut() {
            Some((current_x, ys)) if current_x.total_cmp(&x).is_eq() => ys.push((y, fitted)),
            _ => groups.push((x, vec![(y, fitted)])),
        }
    }

    let unique_x = groups.len() as u64;
    let pure_error_df = rows.len() as u64 - unique_x;
    let lack_of_fit_df = unique_x.saturating_sub(parameter_count as u64);
    if pure_error_df == 0 || lack_of_fit_df == 0 || residual_df == 0 {
        return LackOfFitResult::NotIdentifiable;
    }

    let mut pure_error_ss = 0.0_f64;
    for (_, rows_at_x) in &groups {
        if rows_at_x.len() <= 1 {
            continue;
        }
        let mean_fitted = mean(rows_at_x.iter().map(|(_, fitted)| *fitted));
        pure_error_ss += rows_at_x
            .iter()
            .map(|(actual, _)| square(*actual - mean_fitted))
            .sum::<f64>();
    }
    pure_error_ss = normalize_small_zero(pure_error_ss);
    let lack_of_fit_ss = normalize_small_zero((ss_error - pure_error_ss).max(0.0));
    let ms_lack_of_fit = safe_divide(lack_of_fit_ss, lack_of_fit_df as f64);
    let ms_pure_error = safe_divide(pure_error_ss, pure_error_df as f64);
    let f_ratio = match (ms_lack_of_fit, ms_pure_error) {
        (Some(numerator), Some(denominator)) if denominator > 0.0 => {
            Some(normalize_signed_zero(numerator / denominator))
        }
        _ => None,
    };
    let p_value = f_ratio.and_then(|value| upper_tail_f(value, lack_of_fit_df, pure_error_df));

    LackOfFitResult::Available(LackOfFitAvailable {
        rows: vec![
            AnovaRow {
                source: "Lack Of Fit".into(),
                degrees_of_freedom: lack_of_fit_df,
                sum_of_squares: lack_of_fit_ss,
                mean_square: ms_lack_of_fit,
                f_ratio,
                p_value,
            },
            AnovaRow {
                source: "Pure Error".into(),
                degrees_of_freedom: pure_error_df,
                sum_of_squares: pure_error_ss,
                mean_square: ms_pure_error,
                f_ratio: None,
                p_value: None,
            },
            AnovaRow {
                source: "Total Error".into(),
                degrees_of_freedom: residual_df,
                sum_of_squares: ss_error,
                mean_square: None,
                f_ratio: None,
                p_value: None,
            },
        ],
    })
}

fn sample_standard_deviation(sum_of_squares: f64, count: u64) -> Option<f64> {
    if count < 2 {
        return None;
    }
    safe_divide(sum_of_squares, (count - 1) as f64).map(|value| normalize_signed_zero(value.sqrt()))
}

fn confidence_interval(
    estimate: f64,
    standard_error: Option<f64>,
    degrees_of_freedom: u64,
    confidence_level: f64,
) -> (Option<f64>, Option<f64>) {
    match (
        standard_error,
        t_critical(degrees_of_freedom, confidence_level),
    ) {
        (Some(standard_error_value), Some(critical_value)) => {
            let margin = standard_error_value * critical_value;
            (
                Some(normalize_signed_zero(estimate - margin)),
                Some(normalize_signed_zero(estimate + margin)),
            )
        }
        _ => (None, None),
    }
}

fn t_critical(degrees_of_freedom: u64, confidence_level: f64) -> Option<f64> {
    if degrees_of_freedom == 0 || !(0.0..1.0).contains(&confidence_level) {
        return None;
    }

    StudentsT::new(0.0, 1.0, degrees_of_freedom as f64)
        .ok()
        .map(|distribution| distribution.inverse_cdf(1.0 - (1.0 - confidence_level) / 2.0))
        .filter(|value| value.is_finite())
        .map(normalize_signed_zero)
}

fn two_sided_t_p_value(t_ratio: f64, degrees_of_freedom: u64) -> Option<f64> {
    if degrees_of_freedom == 0 {
        return None;
    }

    StudentsT::new(0.0, 1.0, degrees_of_freedom as f64)
        .ok()
        .map(|distribution| clamp_probability(2.0 * distribution.sf(t_ratio.abs())))
}

fn upper_tail_f(f_ratio: f64, numerator_df: u64, denominator_df: u64) -> Option<f64> {
    if numerator_df == 0 || denominator_df == 0 {
        return None;
    }

    FisherSnedecor::new(numerator_df as f64, denominator_df as f64)
        .ok()
        .map(|distribution| clamp_probability(distribution.sf(f_ratio.max(0.0))))
}

fn ratio_or_none(numerator: f64, denominator: f64) -> Option<f64> {
    if denominator == 0.0 {
        None
    } else {
        Some(normalize_signed_zero(numerator / denominator))
    }
}

fn safe_divide(numerator: f64, denominator: f64) -> Option<f64> {
    if denominator == 0.0 {
        return None;
    }

    let value = numerator / denominator;
    if value.is_finite() {
        Some(normalize_signed_zero(value))
    } else {
        None
    }
}

fn mean<I>(values: I) -> f64
where
    I: IntoIterator<Item = f64>,
{
    let mut count = 0.0_f64;
    let mut mean = 0.0_f64;

    for value in values {
        count += 1.0;
        mean += (value - mean) / count;
    }

    normalize_signed_zero(mean)
}

fn centered_sum_of_squares<I>(values: I, center: f64) -> f64
where
    I: IntoIterator<Item = f64>,
{
    normalize_small_zero(values.into_iter().map(|value| square(value - center)).sum())
}

fn clamp_probability(value: f64) -> f64 {
    if value.is_nan() {
        1.0
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn square(value: f64) -> f64 {
    value * value
}

fn normalize_small_zero(value: f64) -> f64 {
    if value.abs() <= 1e-12 {
        0.0
    } else {
        normalize_signed_zero(value)
    }
}

fn normalize_signed_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn not_computable(
    personality: FitYByXPersonality,
    reason: FitYByXNotComputableReason,
    used_rows: u64,
    excluded_rows: u64,
    confidence_level: f64,
) -> FitYByXResult {
    FitYByXResult::NotComputable(NotComputableResult {
        personality,
        reason,
        used_rows,
        excluded_rows,
        confidence_level,
    })
}

#[cfg(test)]
mod tests {
    use crate::models::fit_y_by_x::{
        FitYByXNotComputableReason, FitYByXPersonality, FitYByXResult, FitYByXRow,
        NotComputableResult,
    };

    use super::{calculate_bivariate, calculate_oneway};

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "actual={actual}, expected={expected}, tolerance={tolerance}"
        );
    }

    #[test]
    fn oneway_perfect_separation_matches_fixture() {
        let rows = vec![
            FitYByXRow::Oneway {
                y: 1.0,
                group: "A".into(),
            },
            FitYByXRow::Oneway {
                y: 2.0,
                group: "A".into(),
            },
            FitYByXRow::Oneway {
                y: 4.0,
                group: "B".into(),
            },
            FitYByXRow::Oneway {
                y: 5.0,
                group: "B".into(),
            },
        ];

        let result = calculate_oneway(rows, 0, 0.95);
        let FitYByXResult::Oneway(oneway) = result else {
            panic!("expected oneway result");
        };

        assert_eq!(oneway.used_rows, 4);
        assert_eq!(oneway.excluded_rows, 0);
        assert_eq!(oneway.confidence_level, 0.95);
        assert_close(oneway.group_summaries[0].mean, 1.5, 1e-12);
        assert_close(oneway.group_summaries[1].mean, 4.5, 1e-12);
        assert_close(oneway.anova[0].sum_of_squares, 9.0, 1e-12);
        assert_close(oneway.anova[1].sum_of_squares, 1.0, 1e-12);
        assert_close(oneway.anova[2].sum_of_squares, 10.0, 1e-12);
        assert_close(oneway.anova[0].f_ratio.unwrap_or(f64::NAN), 18.0, 1e-12);
        assert_close(oneway.effect_sizes.eta_squared, 0.9, 1e-12);
        assert_close(
            oneway.effect_sizes.omega_squared.unwrap_or(f64::NAN),
            0.8095238095,
            1e-10,
        );
    }

    #[test]
    fn bivariate_exact_line_matches_fixture() {
        let rows = vec![(1.0, 3.0), (2.0, 5.0), (3.0, 7.0), (4.0, 9.0)];

        let result = calculate_bivariate(rows, 0, 0.95);
        let FitYByXResult::Bivariate(bivariate) = result else {
            panic!("expected bivariate result");
        };

        assert_eq!(bivariate.used_rows, 4);
        assert_eq!(bivariate.excluded_rows, 0);
        assert_eq!(bivariate.confidence_level, 0.95);
        assert_close(bivariate.intercept, 1.0, 1e-12);
        assert_close(bivariate.slope, 2.0, 1e-12);
        assert_close(
            bivariate.summary_of_fit.r_squared.unwrap_or(f64::NAN),
            1.0,
            1e-12,
        );
        assert_close(bivariate.anova[0].sum_of_squares, 20.0, 1e-12);
        assert_close(bivariate.anova[1].sum_of_squares, 0.0, 1e-12);
        assert_eq!(bivariate.parameter_estimates.len(), 2);

        let intercept = &bivariate.parameter_estimates[0];
        assert_eq!(intercept.term, "Intercept");
        assert_eq!(intercept.standard_error, Some(0.0));
        assert_eq!(intercept.t_ratio, None);
        assert_eq!(intercept.p_value, None);
        assert_eq!(intercept.lower_confidence_limit, Some(intercept.estimate));
        assert_eq!(intercept.upper_confidence_limit, Some(intercept.estimate));

        let slope = &bivariate.parameter_estimates[1];
        assert_eq!(slope.term, "Slope");
        assert_eq!(slope.standard_error, Some(0.0));
        assert_eq!(slope.t_ratio, None);
        assert_eq!(slope.p_value, None);
        assert_eq!(slope.lower_confidence_limit, Some(slope.estimate));
        assert_eq!(slope.upper_confidence_limit, Some(slope.estimate));
    }

    #[test]
    fn bivariate_noisy_line_returns_finite_inference() {
        let rows = vec![(1.0, 2.2), (2.0, 4.1), (3.0, 5.8), (4.0, 8.4), (5.0, 9.9)];

        let result = calculate_bivariate(rows, 1, 0.95);
        let FitYByXResult::Bivariate(bivariate) = result else {
            panic!("expected bivariate result");
        };

        assert_eq!(bivariate.used_rows, 5);
        assert_eq!(bivariate.excluded_rows, 1);
        assert!(bivariate
            .parameter_estimates
            .iter()
            .all(|row| row.standard_error.unwrap_or(f64::NAN).is_finite()));
        assert!(bivariate
            .parameter_estimates
            .iter()
            .all(|row| row.p_value.unwrap_or(f64::NAN).is_finite()));
        assert!(bivariate
            .summary_of_fit
            .root_mean_square_error
            .unwrap_or(f64::NAN)
            .is_finite());
    }

    #[test]
    fn bivariate_replicated_x_returns_lack_of_fit_breakdown() {
        let rows = vec![
            (1.0, 1.0),
            (1.0, 1.4),
            (2.0, 2.2),
            (2.0, 2.9),
            (3.0, 3.2),
            (3.0, 4.1),
        ];

        let result = calculate_bivariate(rows, 0, 0.95);
        let FitYByXResult::Bivariate(bivariate) = result else {
            panic!("expected bivariate result");
        };

        assert!(bivariate.lack_of_fit.is_available());
        let lack_of_fit = bivariate
            .lack_of_fit
            .available()
            .expect("expected available state");
        assert_eq!(lack_of_fit.rows.len(), 3);
        assert_close(bivariate.intercept, 0.016666666666666607, 1e-12);
        assert_close(bivariate.slope, 1.225, 1e-12);
        assert_close(bivariate.anova[0].sum_of_squares, 6.0025, 1e-12);
        assert_close(bivariate.anova[1].sum_of_squares, 0.7508333333333334, 1e-12);
        assert_close(bivariate.anova[2].sum_of_squares, 6.753333333333334, 1e-12);
        assert_close(
            bivariate.anova[0].mean_square.unwrap_or(f64::NAN),
            6.0025,
            1e-12,
        );
        assert_close(
            bivariate.anova[1].mean_square.unwrap_or(f64::NAN),
            0.18770833333333337,
            1e-12,
        );
        assert_close(
            lack_of_fit.rows[0].sum_of_squares,
            0.02083333333333337,
            1e-12,
        );
        assert_eq!(lack_of_fit.rows[0].degrees_of_freedom, 1);
        assert_close(
            lack_of_fit.rows[0].mean_square.unwrap_or(f64::NAN),
            0.02083333333333337,
            1e-12,
        );
        assert_close(lack_of_fit.rows[1].sum_of_squares, 0.73, 1e-12);
        assert_eq!(lack_of_fit.rows[1].degrees_of_freedom, 3);
        assert_close(
            lack_of_fit.rows[1].mean_square.unwrap_or(f64::NAN),
            0.24333333333333332,
            1e-12,
        );
        assert_eq!(lack_of_fit.rows[2].degrees_of_freedom, 4);
        assert_close(
            lack_of_fit.rows[2].sum_of_squares,
            0.7508333333333334,
            1e-12,
        );
        assert_close(
            lack_of_fit.rows[0].f_ratio.unwrap_or(f64::NAN),
            0.08561643835616453,
            1e-12,
        );
        assert_close(
            lack_of_fit.rows[0].p_value.unwrap_or(f64::NAN),
            0.7888961295528955,
            1e-12,
        );
        assert_close(
            bivariate.anova[0].sum_of_squares + bivariate.anova[1].sum_of_squares,
            bivariate.anova[2].sum_of_squares,
            1e-12,
        );
        assert_close(
            lack_of_fit.rows[0].sum_of_squares + lack_of_fit.rows[1].sum_of_squares,
            lack_of_fit.rows[2].sum_of_squares,
            1e-12,
        );
    }

    #[test]
    fn bivariate_without_repeated_x_marks_lack_of_fit_not_identifiable() {
        let rows = vec![(1.0, 2.0), (2.0, 3.1), (3.0, 5.2), (4.0, 6.9)];

        let result = calculate_bivariate(rows, 0, 0.95);
        let FitYByXResult::Bivariate(bivariate) = result else {
            panic!("expected bivariate result");
        };

        assert!(bivariate.lack_of_fit.is_not_identifiable());
    }

    #[test]
    fn bivariate_constant_x_is_not_computable() {
        let rows = vec![(3.0, 1.0), (3.0, 2.0), (3.0, 3.0), (3.0, 4.0)];

        let result = calculate_bivariate(rows, 0, 0.95);

        assert_eq!(
            result,
            FitYByXResult::NotComputable(NotComputableResult {
                personality: FitYByXPersonality::Bivariate,
                reason: FitYByXNotComputableReason::ConstantFactor,
                used_rows: 4,
                excluded_rows: 0,
                confidence_level: 0.95,
            })
        );
    }

    #[test]
    fn bivariate_requires_at_least_three_rows() {
        let result = calculate_bivariate(vec![(1.0, 2.0), (2.0, 4.0)], 3, 0.95);

        assert_eq!(
            result,
            FitYByXResult::NotComputable(NotComputableResult {
                personality: FitYByXPersonality::Bivariate,
                reason: FitYByXNotComputableReason::InsufficientValidRows,
                used_rows: 2,
                excluded_rows: 3,
                confidence_level: 0.95,
            })
        );
    }

    #[test]
    fn oneway_requires_at_least_two_groups() {
        let rows = vec![
            FitYByXRow::Oneway {
                y: 1.0,
                group: "A".into(),
            },
            FitYByXRow::Oneway {
                y: 2.0,
                group: "A".into(),
            },
        ];

        let result = calculate_oneway(rows, 0, 0.95);

        assert_eq!(
            result,
            FitYByXResult::NotComputable(NotComputableResult {
                personality: FitYByXPersonality::Oneway,
                reason: FitYByXNotComputableReason::InsufficientGroups,
                used_rows: 2,
                excluded_rows: 0,
                confidence_level: 0.95,
            })
        );
    }

    #[test]
    fn oneway_zero_within_group_degrees_of_freedom_preserves_partial_results() {
        let rows = vec![
            FitYByXRow::Oneway {
                y: 1.0,
                group: "A".into(),
            },
            FitYByXRow::Oneway {
                y: 2.0,
                group: "B".into(),
            },
        ];

        let result = calculate_oneway(rows, 1, 0.95);

        let FitYByXResult::Oneway(oneway) = result else {
            panic!("expected oneway result");
        };

        assert_eq!(oneway.used_rows, 2);
        assert_eq!(oneway.excluded_rows, 1);
        assert_eq!(oneway.confidence_level, 0.95);
        assert_eq!(oneway.group_summaries.len(), 2);
        assert_eq!(oneway.group_summaries[0].group, "A");
        assert_eq!(oneway.group_summaries[0].count, 1);
        assert_close(oneway.group_summaries[0].mean, 1.0, 1e-12);
        assert!(oneway.group_summaries[0].standard_deviation.is_none());
        assert!(oneway.group_summaries[0].standard_error.is_none());
        assert!(oneway.group_summaries[0].lower_confidence_limit.is_none());
        assert!(oneway.group_summaries[0].upper_confidence_limit.is_none());
        assert_eq!(oneway.group_summaries[1].group, "B");
        assert_eq!(oneway.group_summaries[1].count, 1);
        assert_close(oneway.group_summaries[1].mean, 2.0, 1e-12);
        assert_eq!(oneway.anova.len(), 3);
        assert_eq!(oneway.anova[0].source, "Between");
        assert_eq!(oneway.anova[0].degrees_of_freedom, 1);
        assert_close(oneway.anova[0].sum_of_squares, 0.5, 1e-12);
        assert_close(oneway.anova[0].mean_square.unwrap_or(f64::NAN), 0.5, 1e-12);
        assert!(oneway.anova[0].f_ratio.is_none());
        assert!(oneway.anova[0].p_value.is_none());
        assert_eq!(oneway.anova[1].source, "Within");
        assert_eq!(oneway.anova[1].degrees_of_freedom, 0);
        assert_close(oneway.anova[1].sum_of_squares, 0.0, 1e-12);
        assert!(oneway.anova[1].mean_square.is_none());
        assert!(oneway.anova[1].f_ratio.is_none());
        assert!(oneway.anova[1].p_value.is_none());
        assert_eq!(oneway.anova[2].source, "Total");
        assert_eq!(oneway.anova[2].degrees_of_freedom, 1);
        assert_close(oneway.anova[2].sum_of_squares, 0.5, 1e-12);
        assert!(oneway.anova[2].mean_square.is_none());
        assert_close(oneway.effect_sizes.eta_squared, 1.0, 1e-12);
        assert!(oneway.effect_sizes.omega_squared.is_none());
    }

    #[test]
    fn oneway_two_singleton_groups_with_identical_values_keeps_omega_squared_null() {
        let rows = vec![
            FitYByXRow::Oneway {
                y: 1.0,
                group: "A".into(),
            },
            FitYByXRow::Oneway {
                y: 1.0,
                group: "B".into(),
            },
        ];

        let result = calculate_oneway(rows, 0, 0.95);

        let FitYByXResult::Oneway(oneway) = result else {
            panic!("expected oneway result");
        };

        assert_eq!(oneway.used_rows, 2);
        assert_eq!(oneway.excluded_rows, 0);
        assert_eq!(oneway.confidence_level, 0.95);
        assert_eq!(oneway.group_summaries.len(), 2);
        assert_close(oneway.group_summaries[0].mean, 1.0, 1e-12);
        assert_close(oneway.group_summaries[1].mean, 1.0, 1e-12);
        assert_close(oneway.anova[0].sum_of_squares, 0.0, 1e-12);
        assert_close(oneway.anova[1].sum_of_squares, 0.0, 1e-12);
        assert_close(oneway.anova[2].sum_of_squares, 0.0, 1e-12);
        assert!(oneway.anova[0].mean_square.unwrap_or(f64::NAN).is_finite());
        assert!(oneway.anova[1].mean_square.is_none());
        assert!(oneway.effect_sizes.omega_squared.is_none());
    }
}
