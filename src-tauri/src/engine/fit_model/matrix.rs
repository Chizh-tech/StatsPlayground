use std::collections::BTreeMap;
use std::collections::BTreeSet;

use nalgebra::DMatrix;

use crate::engine::fit_model::ResolvedTerm;
use crate::models::fit_model::{FitModelCenter, FitModelCenteringMethod, FitModelTermKind};

#[derive(Debug, Clone, PartialEq)]
pub enum MatrixError {
    MissingColumn(String),
    ColumnLengthMismatch {
        column: String,
        expected: usize,
        actual: usize,
    },
    EmptyTrainingData,
    MissingCenter(String),
    InvalidResolvedTerm(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelMatrixSpec {
    terms: Vec<ResolvedTerm>,
    centering_method: FitModelCenteringMethod,
    centers: Vec<FitModelCenter>,
}

impl ModelMatrixSpec {
    pub fn from_columns(
        terms: Vec<ResolvedTerm>,
        centering_method: FitModelCenteringMethod,
        columns: &BTreeMap<String, Vec<f64>>,
    ) -> Result<Self, MatrixError> {
        validate_resolved_terms(&terms)?;
        let referenced = referenced_columns(&terms);
        let row_count = validate_columns(&referenced, columns)?;
        if row_count == 0 {
            return Err(MatrixError::EmptyTrainingData);
        }

        let centers = match centering_method {
            FitModelCenteringMethod::None => Vec::new(),
            FitModelCenteringMethod::Mean => {
                let interaction_columns = interaction_columns(&terms);
                if interaction_columns.is_empty() {
                    Vec::new()
                } else {
                    compute_interaction_centers(&interaction_columns, columns)?
                }
            }
        };

        Ok(Self {
            terms,
            centering_method,
            centers,
        })
    }

    pub fn terms(&self) -> &[ResolvedTerm] {
        &self.terms
    }

    pub fn centering_method(&self) -> &FitModelCenteringMethod {
        &self.centering_method
    }

    pub fn centers(&self) -> &[FitModelCenter] {
        &self.centers
    }

    pub fn transform_training_columns(
        &self,
        columns: &BTreeMap<String, Vec<f64>>,
    ) -> Result<DMatrix<f64>, MatrixError> {
        validate_resolved_terms(&self.terms)?;
        let referenced = referenced_columns(&self.terms);
        let row_count = validate_columns(&referenced, columns)?;
        if row_count == 0 {
            return Err(MatrixError::EmptyTrainingData);
        }

        let mut center_by_name = BTreeMap::new();
        for center in &self.centers {
            center_by_name.insert(center.column_name.as_str(), center.mean);
        }

        let width = self.terms.len() + 1;
        let mut data = Vec::with_capacity(row_count * width);
        for row in 0..row_count {
            data.push(1.0);
            for term in &self.terms {
                let value = match term.kind() {
                    FitModelTermKind::Main => {
                        let column_name = term.main_column().ok_or_else(|| {
                            MatrixError::InvalidResolvedTerm(format!(
                                "main term '{}' does not have exactly one column",
                                term.term_id()
                            ))
                        })?;
                        read_value(columns, column_name, row)?
                    }
                    FitModelTermKind::Interaction => {
                        let (left_name, right_name) =
                            term.interaction_columns().ok_or_else(|| {
                                MatrixError::InvalidResolvedTerm(format!(
                                    "interaction term '{}' does not have exactly two columns",
                                    term.term_id()
                                ))
                            })?;
                        let left = read_value(columns, left_name, row)?;
                        let right = read_value(columns, right_name, row)?;
                        match self.centering_method {
                            FitModelCenteringMethod::None => left * right,
                            FitModelCenteringMethod::Mean => {
                                let left_center = center_by_name
                                    .get(left_name)
                                    .copied()
                                    .ok_or_else(|| MatrixError::MissingCenter(left_name.to_string()))?;
                                let right_center = center_by_name
                                    .get(right_name)
                                    .copied()
                                    .ok_or_else(|| {
                                        MatrixError::MissingCenter(right_name.to_string())
                                    })?;
                                (left - left_center) * (right - right_center)
                            }
                        }
                    }
                };
                data.push(value);
            }
        }

        Ok(DMatrix::from_row_slice(row_count, width, &data))
    }
}

fn referenced_columns(terms: &[ResolvedTerm]) -> BTreeSet<String> {
    let mut referenced = BTreeSet::new();
    for term in terms {
        for name in term.column_names() {
            referenced.insert(name.clone());
        }
    }
    referenced
}

fn interaction_columns(terms: &[ResolvedTerm]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for term in terms {
        if term.kind() == &FitModelTermKind::Interaction {
            for name in term.column_names() {
                names.insert(name.clone());
            }
        }
    }
    names.into_iter().collect()
}

fn validate_columns(
    referenced: &BTreeSet<String>,
    columns: &BTreeMap<String, Vec<f64>>,
) -> Result<usize, MatrixError> {
    let mut expected_len: Option<usize> = None;
    for name in referenced {
        let column = columns
            .get(name)
            .ok_or_else(|| MatrixError::MissingColumn(name.clone()))?;
        match expected_len {
            Some(value) if value != column.len() => {
                return Err(MatrixError::ColumnLengthMismatch {
                    column: name.clone(),
                    expected: value,
                    actual: column.len(),
                });
            }
            Some(_) => {}
            None => {
                expected_len = Some(column.len());
            }
        }
    }

    Ok(expected_len.unwrap_or(0))
}

fn compute_interaction_centers(
    interaction_columns: &[String],
    columns: &BTreeMap<String, Vec<f64>>,
) -> Result<Vec<FitModelCenter>, MatrixError> {
    let mut expected_len: Option<usize> = None;
    for name in interaction_columns {
        let column = columns
            .get(name)
            .ok_or_else(|| MatrixError::MissingColumn(name.clone()))?;
        match expected_len {
            Some(value) if value != column.len() => {
                return Err(MatrixError::ColumnLengthMismatch {
                    column: name.clone(),
                    expected: value,
                    actual: column.len(),
                });
            }
            Some(_) => {}
            None => expected_len = Some(column.len()),
        }
    }

    let row_count = expected_len.unwrap_or(0);
    if row_count == 0 {
        return Err(MatrixError::EmptyTrainingData);
    }

    let mut complete_rows = Vec::new();
    for row in 0..row_count {
        let mut is_complete = true;
        for name in interaction_columns {
            let value = read_value(columns, name, row)?;
            if !value.is_finite() {
                is_complete = false;
                break;
            }
        }
        if is_complete {
            complete_rows.push(row);
        }
    }

    if complete_rows.is_empty() {
        return Err(MatrixError::EmptyTrainingData);
    }

    let mut centers = Vec::with_capacity(interaction_columns.len());
    for name in interaction_columns {
        let mut sum = 0.0;
        for row in &complete_rows {
            sum += read_value(columns, name, *row)?;
        }
        centers.push(FitModelCenter {
            column_name: name.clone(),
            mean: sum / (complete_rows.len() as f64),
        });
    }

    Ok(centers)
}

fn read_value(
    columns: &BTreeMap<String, Vec<f64>>,
    name: &str,
    row: usize,
) -> Result<f64, MatrixError> {
    let column = columns
        .get(name)
        .ok_or_else(|| MatrixError::MissingColumn(name.to_string()))?;
    match column.get(row) {
        Some(value) => Ok(*value),
        None => Err(MatrixError::ColumnLengthMismatch {
            column: name.to_string(),
            expected: row + 1,
            actual: column.len(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::fit_model::terms::resolve_terms;
    use crate::models::fit_model::FitModelTerm;

    fn resolved_terms(terms: &[(&str, &[&str])]) -> Vec<ResolvedTerm> {
        let wire_terms = terms
            .iter()
            .map(|(kind, columns)| {
                let mapped_kind = match *kind {
                    "main" => FitModelTermKind::Main,
                    "interaction" => FitModelTermKind::Interaction,
                    _ => panic!("unsupported test term kind: {kind}"),
                };
                FitModelTerm {
                    kind: mapped_kind,
                    column_names: columns.iter().map(|value| (*value).to_string()).collect(),
                }
            })
            .collect::<Vec<_>>();

        resolve_terms(&wire_terms).expect("terms should resolve")
    }

    fn columns() -> BTreeMap<String, Vec<f64>> {
        BTreeMap::from([
            ("A".to_string(), vec![1.0, 3.0]),
            ("B".to_string(), vec![2.0, 6.0]),
        ])
    }

    #[test]
    fn raw_interaction_uses_uncentered_inputs() {
        let terms = resolved_terms(&[("main", &["A"]), ("main", &["B"]), ("interaction", &["A", "B"])]);
        let spec = ModelMatrixSpec::from_columns(terms, FitModelCenteringMethod::None, &columns())
            .expect("spec should build");

        let matrix = spec
            .transform_training_columns(&columns())
            .expect("matrix should build");

        let expected = DMatrix::from_row_slice(2, 4, &[1.0, 1.0, 2.0, 2.0, 1.0, 3.0, 6.0, 18.0]);
        assert_eq!(matrix, expected);
        assert!(spec.centers().is_empty());
    }

    #[test]
    fn mean_centered_interaction_keeps_main_effect_columns_raw() {
        let terms = resolved_terms(&[("main", &["A"]), ("main", &["B"]), ("interaction", &["A", "B"])]);
        let spec = ModelMatrixSpec::from_columns(terms, FitModelCenteringMethod::Mean, &columns())
            .expect("spec should build");

        let matrix = spec
            .transform_training_columns(&columns())
            .expect("matrix should build");

        let expected = DMatrix::from_row_slice(2, 4, &[1.0, 1.0, 2.0, 2.0, 1.0, 3.0, 6.0, 2.0]);
        assert_eq!(matrix, expected);
        assert_eq!(
            spec.centers(),
            vec![
                FitModelCenter {
                    column_name: "A".into(),
                    mean: 2.0,
                },
                FitModelCenter {
                    column_name: "B".into(),
                    mean: 4.0,
                },
            ]
        );
    }

    #[test]
    fn read_only_accessors_expose_spec_state() {
        let terms = resolved_terms(&[("main", &["A"]), ("main", &["B"]), ("interaction", &["A", "B"])]);
        let spec = ModelMatrixSpec::from_columns(terms, FitModelCenteringMethod::Mean, &columns())
            .expect("spec should build");

        assert_eq!(spec.terms().len(), 3);
        assert_eq!(spec.centering_method(), &FitModelCenteringMethod::Mean);
        assert_eq!(spec.centers().len(), 2);
    }

    #[test]
    fn malformed_internal_term_returns_error_not_panic() {
        let malformed = ResolvedTerm::from_parts_for_test(
            "A".into(),
            FitModelTermKind::Main,
            vec![],
            "A".into(),
        );
        let spec = ModelMatrixSpec {
            terms: vec![malformed],
            centering_method: FitModelCenteringMethod::None,
            centers: vec![],
        };

        let result = spec.transform_training_columns(&columns());
        assert_eq!(
            result,
            Err(MatrixError::InvalidResolvedTerm(
                "main term 'A' does not have exactly one column".into(),
            ))
        );
    }
}

fn validate_resolved_terms(terms: &[ResolvedTerm]) -> Result<(), MatrixError> {
    for term in terms {
        match term.kind() {
            FitModelTermKind::Main => {
                if term.main_column().is_none() {
                    return Err(MatrixError::InvalidResolvedTerm(format!(
                        "main term '{}' does not have exactly one column",
                        term.term_id()
                    )));
                }
            }
            FitModelTermKind::Interaction => {
                if term.interaction_columns().is_none() {
                    return Err(MatrixError::InvalidResolvedTerm(format!(
                        "interaction term '{}' does not have exactly two columns",
                        term.term_id()
                    )));
                }
            }
        }
    }

    Ok(())
}