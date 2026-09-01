pub mod matrix;
pub mod terms;

pub use matrix::{MatrixError, ModelMatrixSpec};
pub use terms::{resolve_terms, ResolvedTerm, TermError};