# Task 3 Report - Share One Archive Cell Encoder

## RED
- Added `services::archive_cell::tests::writer_matches_compose_table_doc_for_supported_archive_types` before implementing API.
- First run of `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture` failed with missing `write_archive_cell` API in module and test compile errors.

## GREEN
- Implemented shared encoder in `src-tauri/src/services/archive_cell.rs`:
  - `write_archive_cell<W: Write>(...) -> Result<(), AppError>`
  - `archive_cell_to_json(...) -> Result<serde_json::Value, AppError>`
  - shared `is_archive_scalar_type` and `archive_export_expression`
- Switched `ProjectService::compose_table_doc` to shared conversion (`archive_cell_to_json`) for both scalar and tagged complex cells.
- Removed duplicated conversion helpers from `project_service.rs`.

## Compatibility Matrix (compose v3 semantics lock)
Tested by comparing `compose_table_doc` output vs direct `write_archive_cell` bytes->JSON parse for each column type:

- `NULL` -> JSON `null`
- `BOOLEAN` -> JSON boolean
- `BIGINT` (signed integer) -> JSON number
- `UBIGINT` (unsigned integer) -> preserved current compose semantics (current path output)
- `DOUBLE` -> JSON number (finite), non-finite now returns deterministic `AppError::InvalidParam`
- `VARCHAR` with newline/quotes/backslash -> JSON string with serde escaping
- `BLOB` -> tagged object `{ "$duckdbValue": "DEADBEEF" }` (uppercase hex convention preserved)
- `DECIMAL` -> tagged object
- `DATE` -> tagged object
- `TIME` -> tagged object
- `TIMESTAMP` -> tagged object
- `LIST` -> tagged object
- `ARRAY` -> tagged object
- `MAP` -> tagged object
- `STRUCT` -> tagged object
- `UNION` -> tagged object
- `UUID` -> tagged object
- `ENUM` -> tagged object

## Focused Verification
- `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture` -> pass
- `cargo check --manifest-path src-tauri/Cargo.toml` -> pass

## Concerns
- `write_archive_cell` is newly added for streaming writer integration; currently used by tests and ready for task 4 streaming table entry writing.
- This task intentionally did not change query display JSON semantics or frontend/command wiring.

## Round 1 Fix (review head ab6769e)

### RED (review findings)
- Replaced the circular compose-vs-writer oracle with independent golden assertions in `services::archive_cell::tests::golden_scalar_and_tagged_cases_are_independent_of_compose`.
- Added a high-risk edge matrix based on actual `duckdb::types::Value` variants in `services::archive_cell::tests::edge_matrix_uses_real_duckdb_values`.
- Added sink-failure classification coverage in `services::archive_cell::tests::writer_sink_failures_map_to_fileio_and_allow_partial_bytes`.
- Added standalone export behavior route coverage in `services::archive_cell::tests::standalone_export_table_route_matches_shared_cell_encoding_behavior`.

### GREEN (code + tests)
- `is_archive_scalar_type` now treats unsigned integer types as scalar archive types:
  - `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`
- `write_archive_cell` now maps writer/sink serialization failures to `AppError::FileIO`.
- Non-finite float inputs remain `AppError::InvalidParam`.
- Added/updated tests covering:
  - `UBIGINT` > `i64::MAX` up to `u64::MAX`
  - `-0.0` JSON behavior
  - `NaN` / `+Inf` / `-Inf` deterministic invalid-param failure
  - decimal sign/scale + temporal + timezone variant handling through real DuckDB values
  - escaped text / BLOB uppercase / nested complex tagged strings
  - sink partial-write semantics (no rollback guarantee at cell level)
  - standalone `export_table` behavior path (not source text assertions)

### Verification
- `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture` -> pass
- `cargo check --manifest-path src-tauri/Cargo.toml` -> pass

## Round 1 Completion (takeover)

- Preserved existing uncommitted `archive_cell.rs` compatibility diff and audited against review base `ab6769e5ff36e97730de4ba05349614b184861a1`.
- Closed the remaining edge gap by extending real DuckDB edge coverage with explicit `UBIGINT` just-over-`i64::MAX` (`9223372036854775808`) in addition to `u64::MAX`.
- Added a nested tagged complex golden case with explicit expected JSON payload to strengthen compatibility lock for nested textual complex values.
- Re-ran focused verification and restored generated schema outputs after commands.

### Verification (takeover run)
- `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture` -> pass
- `cargo check --manifest-path src-tauri/Cargo.toml` -> pass

## Round 2 Fix (review head 842b01c)

### Findings addressed
- Replaced dynamic expected fallback in `edge_matrix_uses_real_duckdb_values` with fixed literal `serde_json` expectations for decimal/temporal/list/array/map/struct/union/enum payloads captured from legacy pre-extraction behavior.
- Added a guard assertion in the edge-matrix test to ensure runtime `unwrap_or_else(... format!("{:?}", value) ...)` fallback is not used.
- Restored pre-extraction archive scalar gate behavior by removing unsigned SQL types from `is_archive_scalar_type` (`UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`).
- Added golden integration coverage for legacy unsigned overflow shapes in compose/export paths:
  - compose path: `compose_table_doc_preserves_legacy_unsigned_overflow_tagged_shape`
  - standalone export path: updated `standalone_export_table_route_matches_shared_cell_encoding_behavior`
  - verifies values over `i64::MAX` and over `u64::MAX` remain tagged/string archive payloads.

### TDD sequence evidence
- RED after literal expectation rewrite (before gate rollback):
  - `edge_matrix_uses_real_duckdb_values` failed on `UBIGINT` shape (plain string vs tagged legacy object).
  - `golden_scalar_and_tagged_cases_are_independent_of_compose` failed on `UBIGINT` shape.
  - `standalone_export_table_route_matches_shared_cell_encoding_behavior` failed on `UBIGINT` shape.
  - `compose_table_doc_preserves_legacy_unsigned_overflow_tagged_shape` failed on `UBIGINT` values over `i64::MAX` and `u64::MAX`.
- GREEN after minimal production gate rollback and fixed literal escaping:
  - all focused suites pass.

### Verification (round 2)
- `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture` -> pass
- `cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture` -> pass
- `cargo check --manifest-path src-tauri/Cargo.toml` -> pass

### Ignored findings
- None.
