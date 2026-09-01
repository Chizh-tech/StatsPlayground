use std::collections::BTreeSet;

use crate::models::fit_model::{FitModelResolvedTerm, FitModelTerm, FitModelTermKind};

pub type ResolvedTerm = FitModelResolvedTerm;

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
                mains.push(ResolvedTerm {
                    term_id: column.clone(),
                    kind: FitModelTermKind::Main,
                    column_names: vec![column.clone()],
                    label: column,
                });
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

                interactions.push(ResolvedTerm {
                    term_id: id.clone(),
                    kind: FitModelTermKind::Interaction,
                    column_names: cols,
                    label: id,
                });
            }
        }
    }

    for interaction in &interactions {
        for column in &interaction.column_names {
            if !mains_seen.contains(column) {
                return Err(TermError::MissingMainEffect(column.clone()));
            }
        }
    }

    interactions.sort_by(|left, right| left.term_id.cmp(&right.term_id));

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
}