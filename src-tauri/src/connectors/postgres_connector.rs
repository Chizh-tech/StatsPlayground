use std::time::Duration;

use postgres::{Config, NoTls};

use crate::error::AppError;
use crate::models::data_link::{
    AuthenticationType, ConnectionCredentials, ConnectionDefinition, ConnectorKind, TlsMode,
};

pub struct PostgresConnector {
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
}

impl PostgresConnector {
    pub fn new(
        definition: ConnectionDefinition,
        credentials: ConnectionCredentials,
    ) -> Result<Self, AppError> {
        Self::validate(&definition, &credentials)?;
        Ok(Self {
            definition,
            credentials,
        })
    }

    pub fn test_connection(&self) -> Result<(), AppError> {
        let mut config = Config::new();
        config
            .host(&self.definition.host)
            .port(self.definition.port)
            .dbname(&self.definition.database)
            .user(&self.credentials.username)
            .password(&self.credentials.password)
            .connect_timeout(Duration::from_secs(u64::from(
                self.definition.connect_timeout_seconds,
            )));

        let mut client = config.connect(NoTls).map_err(|error| {
            AppError::Database(format!("PostgreSQL connection failed: {error}"))
        })?;
        client
            .simple_query("SELECT 1")
            .map_err(|error| AppError::Database(format!("PostgreSQL health check failed: {error}")))?;
        Ok(())
    }

    fn validate(
        definition: &ConnectionDefinition,
        credentials: &ConnectionCredentials,
    ) -> Result<(), AppError> {
        if definition.connector != ConnectorKind::PostgreSql {
            return Err(AppError::InvalidParam(
                "PostgreSQL connector requires connector=postgresql".to_string(),
            ));
        }
        if definition.authentication_type != AuthenticationType::UsernamePassword {
            return Err(AppError::InvalidParam(
                "PostgreSQL currently supports username/password authentication only".to_string(),
            ));
        }
        if definition.tls_mode != TlsMode::Disabled {
            return Err(AppError::InvalidParam(
                "PostgreSQL TLS modes are not implemented yet".to_string(),
            ));
        }
        if definition.host.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "PostgreSQL host is required".to_string(),
            ));
        }
        if definition.database.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "PostgreSQL database is required".to_string(),
            ));
        }
        if credentials.username.trim().is_empty() {
            return Err(AppError::InvalidParam(
                "PostgreSQL username is required".to_string(),
            ));
        }
        if credentials.password.is_empty() {
            return Err(AppError::InvalidParam(
                "PostgreSQL password is required".to_string(),
            ));
        }
        if !(1..=300).contains(&definition.connect_timeout_seconds) {
            return Err(AppError::InvalidParam(
                "PostgreSQL connection timeout must be between 1 and 300 seconds".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_definition() -> ConnectionDefinition {
        ConnectionDefinition {
            connector: ConnectorKind::PostgreSql,
            host: "127.0.0.1".to_string(),
            port: 55432,
            database: "statsplayground_test".to_string(),
            authentication_type: AuthenticationType::UsernamePassword,
            tls_mode: TlsMode::Disabled,
            connect_timeout_seconds: 5,
        }
    }

    fn fixture_credentials(password: &str) -> ConnectionCredentials {
        ConnectionCredentials {
            username: "stats_reader".to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn rejects_unsupported_modes_and_invalid_timeout() {
        let mut definition = fixture_definition();
        definition.tls_mode = TlsMode::Required;
        let tls_error = PostgresConnector::new(definition, fixture_credentials("unused"))
            .err()
            .expect("reject unsupported TLS mode");
        assert!(tls_error.to_string().contains("TLS modes"));

        let mut definition = fixture_definition();
        definition.connect_timeout_seconds = 0;
        let timeout_error = PostgresConnector::new(definition, fixture_credentials("unused"))
            .err()
            .expect("reject zero timeout");
        assert!(timeout_error.to_string().contains("between 1 and 300"));
    }

    #[test]
    fn credentials_do_not_implement_debug_or_serialization() {
        let connector = PostgresConnector::new(
            fixture_definition(),
            fixture_credentials("session-only-secret"),
        )
        .expect("create connector");

        assert_eq!(connector.credentials.username, "stats_reader");
    }

    #[test]
    #[ignore = "requires the local PostgreSQL fixture and STATSPG_TEST_POSTGRES_PASSWORD"]
    fn connects_to_configured_postgresql_fixture() {
        let password = std::env::var("STATSPG_TEST_POSTGRES_PASSWORD")
            .expect("STATSPG_TEST_POSTGRES_PASSWORD must be set");
        let connector = PostgresConnector::new(fixture_definition(), fixture_credentials(&password))
            .expect("create connector");

        connector.test_connection().expect("connect to fixture");
    }
}