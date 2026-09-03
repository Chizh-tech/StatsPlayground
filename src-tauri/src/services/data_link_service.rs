use rusqlite::types::ValueRef;

use crate::error::AppError;
use crate::models::data_link::{PreviewResult, SourceColumn, SourceObject};

const MAX_PREVIEW_ROWS: usize = 100;

pub struct DataLinkService;

impl DataLinkService {
    pub fn list_sqlite_objects(file_path: &str) -> Result<Vec<SourceObject>, AppError> {
        let connection = Self::open_sqlite(file_path)?;
        let mut statement = connection.prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let entries = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        entries
            .into_iter()
            .map(|(name, object_type)| {
                Ok(SourceObject {
                    columns: Self::read_columns(&connection, &name)?,
                    name,
                    object_type,
                })
            })
            .collect()
    }

    pub fn preview_sqlite_object(
        file_path: &str,
        object_name: &str,
        limit: usize,
    ) -> Result<PreviewResult, AppError> {
        let connection = Self::open_sqlite(file_path)?;
        let object_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name = ?1 AND name NOT LIKE 'sqlite_%')",
            [object_name],
            |row| row.get(0),
        )?;
        if !object_exists {
            return Err(AppError::InvalidParam(format!(
                "SQLite object not found: {object_name}"
            )));
        }

        let columns = Self::read_columns(&connection, object_name)?;
        let preview_limit = limit.clamp(1, MAX_PREVIEW_ROWS);
        let quoted_name = Self::quote_sqlite_identifier(object_name);
        let query = format!("SELECT * FROM {quoted_name} LIMIT ?1");
        let mut statement = connection.prepare(&query)?;
        let column_count = statement.column_count();
        let mut rows = statement.query([preview_limit + 1])?;
        let mut result_rows = Vec::new();

        while let Some(row) = rows.next()? {
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                values.push(Self::sqlite_value_to_json(row.get_ref(index)?));
            }
            result_rows.push(values);
        }

        let truncated = result_rows.len() > preview_limit;
        result_rows.truncate(preview_limit);
        Ok(PreviewResult {
            object_name: object_name.to_string(),
            columns,
            rows: result_rows,
            truncated,
        })
    }

    fn open_sqlite(file_path: &str) -> Result<rusqlite::Connection, AppError> {
        if file_path.trim().is_empty() {
            return Err(AppError::InvalidParam("SQLite path is required".to_string()));
        }
        Ok(rusqlite::Connection::open_with_flags(
            file_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    }

    fn read_columns(
        connection: &rusqlite::Connection,
        object_name: &str,
    ) -> Result<Vec<SourceColumn>, AppError> {
        let quoted_name = Self::quote_sqlite_identifier(object_name);
        let mut statement = connection.prepare(&format!("PRAGMA table_info({quoted_name})"))?;
        let columns = statement
            .query_map([], |row| {
                Ok(SourceColumn {
                    name: row.get(1)?,
                    source_type: row.get(2)?,
                    nullable: row.get::<_, i32>(3)? == 0,
                    primary_key: row.get::<_, i32>(5)? > 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(columns)
    }

    fn quote_sqlite_identifier(identifier: &str) -> String {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }

    fn sqlite_value_to_json(value: ValueRef<'_>) -> serde_json::Value {
        match value {
            ValueRef::Null => serde_json::Value::Null,
            ValueRef::Integer(value) => value.into(),
            ValueRef::Real(value) => value.into(),
            ValueRef::Text(value) => String::from_utf8_lossy(value).into_owned().into(),
            ValueRef::Blob(value) => format!("<BLOB: {} bytes>", value.len()).into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!("datalink-{}.sqlite", uuid::Uuid::new_v4()))
    }

    #[test]
    fn discovers_tables_views_and_columns() {
        let path = fixture_path();
        let connection = rusqlite::Connection::open(&path).expect("create fixture");
        connection
            .execute_batch(
                "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
                 CREATE VIEW people_view AS SELECT name FROM people;",
            )
            .expect("create objects");
        drop(connection);

        let objects = DataLinkService::list_sqlite_objects(path.to_str().expect("fixture path"))
            .expect("discover objects");

        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].name, "people");
        assert!(objects[0].columns[0].primary_key);
        assert!(!objects[0].columns[1].nullable);
        assert_eq!(objects[1].object_type, "view");
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn previews_with_a_hard_limit_and_safe_blob_representation() {
        let path = fixture_path();
        let connection = rusqlite::Connection::open(&path).expect("create fixture");
        connection
            .execute("CREATE TABLE samples (value TEXT, payload BLOB)", [])
            .expect("create table");
        for index in 0..105 {
            connection
                .execute(
                    "INSERT INTO samples VALUES (?1, ?2)",
                    rusqlite::params![format!("row-{index}"), vec![1_u8, 2, 3]],
                )
                .expect("insert row");
        }
        drop(connection);

        let preview = DataLinkService::preview_sqlite_object(
            path.to_str().expect("fixture path"),
            "samples",
            500,
        )
        .expect("preview object");

        assert_eq!(preview.rows.len(), MAX_PREVIEW_ROWS);
        assert!(preview.truncated);
        assert_eq!(preview.rows[0][1], "<BLOB: 3 bytes>");
        std::fs::remove_file(path).expect("remove fixture");
    }
}
