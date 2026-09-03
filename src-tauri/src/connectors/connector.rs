use crate::error::AppError;
use crate::models::data_link::{PreviewResult, SourceColumn, SourceObject};

pub enum ConnectorValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

pub trait DataConnector {
    fn test_connection(&self) -> Result<(), AppError>;
    fn list_objects(&self) -> Result<Vec<SourceObject>, AppError>;
    fn schema(&self, object_name: &str) -> Result<Vec<SourceColumn>, AppError>;
    fn preview(&self, object_name: &str, limit: usize) -> Result<PreviewResult, AppError>;
    fn row_count(&self, object_name: &str) -> Result<usize, AppError>;
    fn read_rows(
        &self,
        object_name: &str,
        visitor: &mut dyn FnMut(usize, Vec<ConnectorValue>) -> Result<(), AppError>,
    ) -> Result<(), AppError>;
}
