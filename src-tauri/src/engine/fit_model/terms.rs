use std::collections::BTreeSet;

use crate::models::fit_model::{FitModelTerm, FitModelTermKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTerm {
    term_id: String,
    kind: FitModelTermKind,
    column_names: Vec<String>,
    label: String,
}

impl ResolvedTerm {
    fn main(column_name: String) -> Self {
        Self {
            term_id: column_name.clone(),
            kind: FitModelTermKind::Main,
            column_names: vec![column_name.clone()],
            label: column_name,
        }
    }

    fn interaction(left: String, right: String) -> Self {
        let term_id = format!("{left}*{right}");
        Self {
            term_id: term_id.clone(),
            kind: FitModelTermKind::Interaction,
            column_names: vec![left, right],
            label: term_id,
        }
    }

    pub fn term_id(&self) -> &str {
        &self.term_id
    }

    pub fn kind(&self) -> &FitModelTermKind {
        &self.kind
    }

    pub fn column_names(&self) -> &[String] {
        &self.column_names
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn main_column(&self) -> Option<&str> {
        if self.kind == FitModelTermKind::Main && self.column_names.len() == 1 {
            return Some(self.column_names[0].as_str());
        }
        None
    }

    pub fn interaction_columns(&self) -> Option<(&str, &str)> {
        if self.kind == FitModelTermKind::Interaction && self.column_names.len() == 2 {
            return Some((
                self.column_names[0].as_str(),
                self.column_names[1].as_str(),
            ));
        }
        None
    }

    #[cfg(test)]
    pub(crate) fn from_parts_for_test(
        term_id: String,
        kind: FitModelTermKind,
        column_names: Vec<String>,
        label: String,
    ) -> Self {
        Self {
            term_id,
            kind,
            column_names,
            label,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermError {
    EmptyColumnName,
    InvalidArity { kind: FitModelTermKind, expected: usize, actual: usize },
    DuplicateTerm(String),
    MissingMainEffect(String),
    InteractionRequiresDistinctColumns(String),
}

pub fn resolve_terms(terms: &[FitModelTerm]) -> Result<Vec<ResolvedTerm>, TermError> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = BTreeSet::new();
    let mut mains_seen = BTreeSet::new();
    let mut mains = Vec::new();
    let mut interactions = Vec::new();

    for term in terms {
        if term.column_names.iter().any(|value| value.trim().is_empty()) {
            return Err(TermError::EmptyColumnName);
        }

        match term.kind {
            FitModelTermKind::Main => {
                if term.column_names.len() != 1 {
                    return Err(TermError::InvalidArity {
                        kind: FitModelTermKind::Main,
                        expected: 1,
                        actual: term.column_names.len(),
                    });
                }

                let column = term.column_names[0].clone();
                if !seen.insert(column.clone()) {
                    return Err(TermError::DuplicateTerm(column));
                }
                mains_seen.insert(column.clone());
                mains.push(ResolvedTerm::main(column));
            }
            FitModelTermKind::Interaction => {
                if term.column_names.len() != 2 {
                    return Err(TermError::InvalidArity {
                        kind: FitModelTermKind::Interaction,
                        expected: 2,
                        actual: term.column_names.len(),
                    });
                }

                let mut cols = term.column_names.clone();
                cols.sort();
                if cols[0] == cols[1] {
                    return Err(TermError::InteractionRequiresDistinctColumns(cols[0].clone()));
                }
                let id = cols.join("*");
                if !seen.insert(id.clone()) {
                    return Err(TermError::DuplicateTerm(id));
                }

                interactions.push(ResolvedTerm::interaction(cols[0].clone(), cols[1].clone()));
            }
        }
    }

    for interaction in &interactions {
        for column in interaction.column_names() {
            if !mains_seen.contains(column) {
                return Err(TermError::MissingMainEffect(column.clone()));
            }
        }
    }

    interactions.sort_by(|left, right| left.term_id().cmp(right.term_id()));

    let mut resolved = Vec::with_capacity(mains.len() + interactions.len());
    resolved.extend(mains);
    resolved.extend(interactions);

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(kind: &str, columns: &[&str]) -> FitModelTerm {
        let mapped_kind = match kind {
            "main" => FitModelTermKind::Main,
            "interaction" => FitModelTermKind::Interaction,
            _ => panic!("unsupported test term kind: {kind}"),
        };

        FitModelTerm {
            kind: mapped_kind,
            column_names: columns.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    #[test]
    fn interaction_requires_both_main_effects() {
        let terms = vec![term("interaction", &["A", "B"]), term("main", &["A"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::MissingMainEffect("B".into()))
        );
    }

    #[test]
    fn reversed_interaction_is_a_duplicate() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("interaction", &["A", "B"]),
            term("interaction", &["B", "A"]),
        ];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::DuplicateTerm("A*B".into()))
        );
    }

    #[test]
    fn rejects_invalid_wire_main_arity() {
        let terms = vec![term("main", &["A", "B"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::InvalidArity {
                kind: FitModelTermKind::Main,
                expected: 1,
                actual: 2,
            })
        );
    }

    #[test]
    fn rejects_invalid_wire_interaction_arity() {
        let terms = vec![term("interaction", &["A"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::InvalidArity {
                kind: FitModelTermKind::Interaction,
                expected: 2,
                actual: 1,
            })
        );
    }
}