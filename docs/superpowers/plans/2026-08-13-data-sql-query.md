# Data SQL Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure read-only SQL query workflow over globally unique project table names while making Directory folders independent frontend metadata with stable project archive paths.

**Architecture:** Upgrade the project manifest to persist folder assignment maps while table and graph payloads use ID-based archive paths. Enforce case-insensitive dataset-name uniqueness in the DuckDB engine, validate user SQL with a `sqlparser-rs` AST allowlist, execute it through temporary visible-name aliases with DuckDB external access disabled, and expose paginated results through typed Tauri IPC to a dedicated React dialog.

**Tech Stack:** Rust 2021, Tauri v2, DuckDB 1.10505.0, sqlparser 0.62.0, serde, React 19, TypeScript 5.7, Zustand 5, i18next, Font Awesome 6.

## Global Constraints

- SQL accepts exactly one read-only `SELECT` or `WITH ... SELECT` query.
- AST relation sources may reference only project table aliases or in-scope CTEs; reject system schemas, unknown relations, table functions, dynamic query functions, and multiple statements.
- Disable DuckDB external access while user SQL executes and restore it during cleanup.
- Preview page size is exactly 200 rows; backend rejects zero and caps IPC requests at 200.
- Dataset names are globally unique using case-insensitive comparison; folder paths never participate in SQL names.
- Directory folders are persisted as independent manifest metadata for both tables and graphs.
- New archives use `tables/<dataset-id>.sptb` and `graphs/<graph-id>.spgh` regardless of UI folder placement.
- Rust commands return `Result<T, AppError>` and contain no `unwrap()` or `expect()` outside tests.
- Rust models crossing IPC use `#[serde(rename_all = "camelCase")]`; TypeScript mirrors those names.
- Do not commit or push unless the user explicitly requests it.

---

### Task 1: Stable Archive Paths And Folder Metadata

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src/services/projectService.ts`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Produces: `ProjectManifest.table_folders: Option<HashMap<String, String>>`
- Produces: `ProjectManifest.graph_folders: Option<HashMap<String, String>>`
- Preserves: `build_bundle(..., table_folders: &HashMap<String, String>, graph_folders: &HashMap<String, String>, ...) -> ProjectBundle`
- Produces: project version `3.0.0`

- [ ] **Step 1: Add failing archive-format tests**

Add tests that build a bundle with one table in `Raw/2026` and one graph in
`Reports`, then assert stable paths and explicit maps:

```rust
fn table_doc(id: &str, name: &str) -> TableDoc {
    TableDoc {
        id: id.into(),
        name: name.into(),
        source_type: "manual".into(),
        version: "1".into(),
        columns: vec![],
        rows: vec![],
    }
}

fn graph_doc(id: &str, name: &str) -> GraphDoc {
    GraphDoc {
        id: id.into(),
        name: name.into(),
        version: "1".into(),
        body: serde_json::Map::new(),
    }
}

#[test]
fn build_bundle_uses_stable_id_paths_and_explicit_folder_maps() {
    let table = table_doc("table-id", "Sales");
    let graph = graph_doc("graph-id", "Revenue");
    let table_folders = HashMap::from([("table-id".into(), "Raw/2026".into())]);
    let graph_folders = HashMap::from([("graph-id".into(), "Reports".into())]);

    let bundle = build_bundle(
        "Project".into(), "3.0.0".into(), "now".into(),
        vec![table], vec![graph], vec!["Raw/2026".into(), "Reports".into()],
        &table_folders, &graph_folders, vec![], vec![],
    );

    assert_eq!(bundle.manifest.tables[0].file, "tables/table-id.sptb");
    assert_eq!(bundle.manifest.graphs[0].file, "graphs/graph-id.spgh");
    assert_eq!(bundle.manifest.table_folders.as_ref(), Some(&table_folders));
    assert_eq!(bundle.manifest.graph_folders.as_ref(), Some(&graph_folders));
}
```

Add a serialization round-trip test proving `Some(empty_map)` remains present.
This distinguishes a new all-root project from an old path-derived manifest.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive::tests::build_bundle_uses_stable_id_paths_and_explicit_folder_maps
```

Expected: compilation or assertion failure because the manifest lacks the two
folder-map fields and paths are still display-name/folder based.

- [ ] **Step 3: Implement the v3 manifest shape and writer**

Add optional fields so absence identifies v2 archives:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub table_folders: Option<HashMap<String, String>>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub graph_folders: Option<HashMap<String, String>>,
```

Change `build_bundle` to set both fields to `Some(map.clone())` and generate
entry paths only from IDs:

```rust
file: format!("tables/{}.sptb", table.id),
file: format!("graphs/{}.spgh", graph.id),
```

Remove `unique_archive_path` from project-bundle writing if no standalone
export path still uses it. Keep standalone `.sptb`/`.spgh` export behavior
unchanged.

- [ ] **Step 4: Implement compatibility resolution in ProjectService**

Set `SPPRJ_VERSION` to `3.0.0`. In `open_project`, resolve assignments as:

```rust
let table_folders = match &bundle.manifest.table_folders {
    Some(assignments) => assignments.clone(),
    None => derive_folders_from_entries(&bundle.manifest.tables),
};
let graph_folders = match &bundle.manifest.graph_folders {
    Some(assignments) => assignments.clone(),
    None => derive_folders_from_entries(&bundle.manifest.graphs),
};
```

The derivation helper must strip legacy container prefixes such as `tables/`
and `graphs/` so v1 root entries do not become user folders. Update comments in
`projectService.ts` to state that folder maps are manifest metadata rather than
archive routing instructions.

- [ ] **Step 5: Run archive tests and backend build**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive
cargo build
```

Expected: archive tests pass and backend compiles.

---

### Task 2: Global Dataset Name Invariant And Legacy Migration

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/models/project.rs`
- Modify: `src/types/project.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: inline `#[cfg(test)]` modules in `duckdb_engine.rs` and `project_service.rs`

**Interfaces:**
- Produces: `DuckDbEngine::validate_dataset_name(&self, name: &str, exclude_id: Option<&str>) -> Result<(), AppError>`
- Produces: `DatasetNameMigration { dataset_id, old_name, new_name }`
- Extends: `OpenProjectResult.dataset_name_migrations: Vec<DatasetNameMigration>`

- [ ] **Step 1: Add failing engine uniqueness tests**

Cover creation and rename with case-insensitive conflicts:

```rust
#[test]
fn dataset_names_are_unique_case_insensitively() {
    let db = DuckDbEngine::new_in_memory().unwrap();
    db.create_empty_table("one", "Sales", &[], &[]).unwrap();

    let create_error = db.create_empty_table("two", "sales", &[], &[]).unwrap_err();
    assert!(matches!(create_error, AppError::InvalidParam(_)));

    db.create_empty_table("two", "Costs", &[], &[]).unwrap();
    let rename_error = db.rename_dataset("two", "SALES").unwrap_err();
    assert!(matches!(rename_error, AppError::InvalidParam(_)));
}
```

Also test empty, whitespace-only, and self-preserving rename behavior.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
Set-Location src-tauri
cargo test dataset_names_are_unique_case_insensitively
```

Expected: FAIL because duplicate metadata names are currently accepted.

- [ ] **Step 3: Centralize backend name validation**

Implement one authoritative helper using a parameterized metadata query:

```rust
pub fn validate_dataset_name(
    &self,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<(), AppError>
```

Reject an empty name, leading/trailing whitespace or `.`, and any of
`/\:*?"<>|`. Query `_meta_datasets` with `lower(name) = lower($1)` and exclude
`$2` for rename. Return `AppError::InvalidParam` with the conflicting visible
name. Keep this validation dependency-free with character comparisons; do not
add a regex crate.

Call the helper before every dataset-producing or renaming path:

- `import_csv`
- `create_empty_table`
- `rename_dataset`
- SQLite import table creation
- standalone `.sptb` restore/import
- `create_table_from_query` used by sort/subset/transpose/stack/split/summary/join/concatenate
- the SQL result-table path added in Task 4

Because `AppState.db` is mutex-protected, validation and mutation remain
serialized. Do not rely on frontend checks.

- [ ] **Step 4: Add failing duplicate migration tests**

Extract a pure helper and test deterministic suffixing:

```rust
fn table_doc(id: &str, name: &str) -> TableDoc {
    TableDoc {
        id: id.into(),
        name: name.into(),
        source_type: "manual".into(),
        version: "1".into(),
        columns: vec![],
        rows: vec![],
    }
}

#[test]
fn normalizes_legacy_duplicate_dataset_names_in_manifest_order() {
    let mut docs = vec![
        table_doc("one", "Sales"),
        table_doc("two", "sales"),
        table_doc("three", "Sales"),
    ];

    let migrations = normalize_duplicate_dataset_names(&mut docs);

    assert_eq!(docs[0].name, "Sales");
    assert_eq!(docs[1].name, "sales (2)");
    assert_eq!(docs[2].name, "Sales (3)");
    assert_eq!(migrations.len(), 2);
}
```

- [ ] **Step 5: Implement project-load normalization and typed result**

Add the IPC model:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetNameMigration {
    pub dataset_id: String,
    pub old_name: String,
    pub new_name: String,
}
```

Normalize `bundle.tables` before `restore_table_doc`. Extend Rust and
TypeScript `OpenProjectResult` with `datasetNameMigrations`. In
`useProjectStore.openProject`, set `dirty: result.datasetNameMigrations.length
> 0`. In Workspace, show one localized migration message after open, including
the count, without interrupting project loading.

- [ ] **Step 6: Run focused tests and frontend build**

Run:

```powershell
Set-Location src-tauri
cargo test dataset_names_are_unique_case_insensitively
cargo test normalizes_legacy_duplicate_dataset_names_in_manifest_order
Set-Location ..
npm run build
```

Expected: tests and TypeScript/Vite build pass.

---

### Task 3: SQL AST Allowlist

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/engine/mod.rs`
- Create: `src-tauri/src/engine/sql_query.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/engine/sql_query.rs`

**Interfaces:**
- Consumes: globally unique visible dataset names from Task 2
- Produces: `validate_read_only_query(sql: &str, allowed_tables: &HashSet<String>) -> Result<(), AppError>`
- Produces: `normalize_identifier(name: &str) -> String` using the same case-insensitive comparison as dataset names

- [ ] **Step 1: Add the parser dependency and failing validator tests**

Add:

```toml
sqlparser = "0.62.0"
```

Write table-driven tests with allowed tables `Sales` and `Costs`:

```rust
#[test]
fn accepts_project_tables_ctes_derived_queries_and_joins() {
    for sql in [
        "SELECT * FROM Sales",
        "WITH totals AS (SELECT * FROM Sales) SELECT * FROM totals",
        "SELECT * FROM (SELECT * FROM Sales) s",
        "SELECT * FROM Sales JOIN Costs USING (id)",
    ] {
        assert!(validate_read_only_query(sql, &allowed()).is_ok(), "{sql}");
    }
}

#[test]
fn rejects_non_project_and_active_relation_sources() {
    for sql in [
        "SELECT * FROM _meta_datasets",
        "SELECT * FROM information_schema.tables",
        "SELECT * FROM read_csv('secret.csv')",
        "SELECT * FROM query('SELECT 1')",
        "SELECT * FROM Missing",
        "DELETE FROM Sales",
        "SELECT 1; SELECT 2",
    ] {
        assert!(validate_read_only_query(sql, &allowed()).is_err(), "{sql}");
    }
}
```

Add tests for nested CTE scope, scalar subqueries, quoted names with spaces,
case-insensitive matching, and a CTE that shadows a project table.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
Set-Location src-tauri
cargo test engine::sql_query::tests
```

Expected: compilation failure because the validator does not exist.

- [ ] **Step 3: Implement recursive AST validation**

Parse with `DuckDbDialect` and require exactly one `Statement::Query`:

```rust
pub fn validate_read_only_query(
    sql: &str,
    allowed_tables: &HashSet<String>,
) -> Result<(), AppError>
```

Use explicit visitors over `Query`, `SetExpr`, `Select`, `TableWithJoins`,
`TableFactor`, and every expression position that can contain a subquery.
Maintain a scope stack of normalized CTE names. Permit only:

- `TableFactor::Table` whose unqualified name is an allowed project table or
  in-scope CTE.
- `TableFactor::Derived` after recursive query validation.
- Regular joins whose left and right relations both pass.

Reject qualified object names, all table-function variants, `UNNEST`, pivot
sources not rooted in an allowed relation, and AST variants not explicitly
handled. Return `AppError::InvalidParam` with a concise reason. Never fall back
to text scanning.

- [ ] **Step 4: Run validator tests and clippy**

Run:

```powershell
Set-Location src-tauri
cargo test engine::sql_query::tests
cargo clippy -- -D warnings
```

Expected: all validator tests pass with no warnings.

---

### Task 4: DuckDB Query Execution And Result Table Creation

**Files:**
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: `validate_read_only_query` from Task 3
- Produces: `SqlQueryResult`
- Produces: `DuckDbEngine::execute_sql_query(&self, sql: &str, page: usize, page_size: usize) -> Result<SqlQueryResult, AppError>`
- Produces: `DuckDbEngine::create_table_from_sql_query(&self, id: &str, name: &str, sql: &str) -> Result<DatasetMeta, AppError>`

- [ ] **Step 1: Add failing execution tests**

Seed `Sales` and `Costs`, then test:

```rust
fn seeded_query_engine() -> DuckDbEngine {
    let db = DuckDbEngine::new_in_memory().unwrap();
    db.create_empty_table(
        "sales",
        "Sales",
        &["region".into(), "revenue".into()],
        &["VARCHAR".into(), "DOUBLE".into()],
    ).unwrap();
    db.create_empty_table(
        "costs",
        "Costs",
        &["id".into(), "cost".into()],
        &["INTEGER".into(), "DOUBLE".into()],
    ).unwrap();
    db.conn().execute_batch(
        "INSERT INTO dataset_sales VALUES
         (1, 'East', 10.0), (2, 'West', 20.0), (3, 'East', 30.0),
         (4, 'West', 40.0), (5, 'East', 50.0);"
    ).unwrap();
    db
}

#[test]
fn executes_visible_name_query_with_count_types_and_pagination() {
    let db = seeded_query_engine();
    let result = db.execute_sql_query(
        "SELECT region, revenue FROM Sales ORDER BY revenue",
        1,
        2,
    ).unwrap();

    assert_eq!(result.columns, vec!["region", "revenue"]);
    assert_eq!(result.total_rows, 5);
    assert_eq!(result.page, 1);
    assert_eq!(result.page_size, 2);
    assert_eq!(result.rows.len(), 2);
}
```

Add tests for page size `0`, page size above `200`, offset overflow, metadata
access rejection, alias cleanup after a syntax/runtime failure, and external
access restoration after both success and failure.

- [ ] **Step 2: Run the focused execution test and verify failure**

Run:

```powershell
Set-Location src-tauri
cargo test executes_visible_name_query_with_count_types_and_pagination
```

Expected: compilation failure because `execute_sql_query` and
`SqlQueryResult` do not exist.

- [ ] **Step 3: Add the result model and guarded query session**

Add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlQueryResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: i64,
    pub page: usize,
    pub page_size: usize,
    pub execution_time_ms: u64,
}
```

Implement a private `with_sql_query_session` helper that:

1. Reads `(id, name)` from `_meta_datasets`.
2. Validates SQL against normalized visible names.
3. Reads and stores the current `enable_external_access` value, then sets it to false.
4. Creates quoted temporary views from visible names to UUID tables.
5. Runs a closure.
6. Drops every created view and restores the exact original external-access value on all exit paths.

Quote generated identifiers by doubling embedded `"` even though normal name
validation excludes filesystem-unsafe quotes. Preserve the original operation
error if cleanup also fails.

- [ ] **Step 4: Implement paginated execution**

Validate `1 <= page_size <= 200`, use `checked_mul` for the offset, and wrap
the validated SQL:

```sql
SELECT COUNT(*) FROM (<user-query>) AS "_sp_query_count"
SELECT * FROM (<user-query>) AS "_sp_query_page" LIMIT $1 OFFSET $2
```

Bind limit and offset as parameters. Read names and DuckDB logical types from
the prepared page statement, convert values to JSON with one shared helper,
and measure the complete guarded operation with `Instant`.

- [ ] **Step 5: Add failing result-table transaction tests**

Test full creation and rollback:

```rust
#[test]
fn creates_managed_dataset_from_sql_query() {
    let db = seeded_query_engine();
    let meta = db.create_table_from_sql_query(
        "result-id",
        "Regional Totals",
        "SELECT region, sum(revenue) AS total FROM Sales GROUP BY region",
    ).unwrap();

    assert_eq!(meta.source_type, "query");
    assert_eq!(meta.name, "Regional Totals");
    let result = db.query_table("result-id", 0, 200, None, None).unwrap();
    assert_eq!(result.columns[0], "_row_id");
    assert_eq!(result.total_rows, 2);
}
```

Force a metadata conflict inside a test transaction and assert neither the
internal table nor metadata survives.

- [ ] **Step 6: Implement atomic query-result creation**

Inside the guarded session and one DuckDB transaction:

1. Call `validate_dataset_name(name, None)`.
2. Create `dataset_<uuid>` from the validated query.
3. Add/populate `_row_id` with `row_number() over ()` using a staging table if
   DuckDB cannot add the populated column directly.
4. Inspect `information_schema.columns` for user columns.
5. Insert `_meta_datasets` with `source_type = 'query'`.
6. Insert ordered `_meta_columns` rows.
7. Commit and return `get_dataset_meta(id)`.

Do not register `_row_id` in `_meta_columns`.

- [ ] **Step 7: Run engine tests and backend validation**

Run:

```powershell
Set-Location src-tauri
cargo test engine::duckdb_engine
cargo clippy -- -D warnings
```

Expected: execution, cleanup, pagination, creation, and rollback tests pass.

---

### Task 5: Tauri IPC And TypeScript Contracts

**Files:**
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`

**Interfaces:**
- Produces command: `execute_sql_query(sql: String, page: usize, page_size: usize) -> Result<SqlQueryResult, AppError>`
- Produces command: `create_table_from_sql_query(sql: String, name: String) -> Result<DatasetMeta, AppError>`
- Produces TS methods: `dataService.executeSqlQuery(sql, page, pageSize)` and `dataService.createTableFromSqlQuery(sql, name)`

- [ ] **Step 1: Add TypeScript contracts first and verify expected build failure**

Add:

```ts
export interface SqlQueryResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  totalRows: number;
  page: number;
  pageSize: number;
  executionTimeMs: number;
}
```

Extend `DatasetMeta.sourceType` with `"query"`, then add service wrappers:

```ts
executeSqlQuery: (sql: string, page: number, pageSize = 200) =>
  invoke<SqlQueryResult>("execute_sql_query", { sql, page, pageSize }),
createTableFromSqlQuery: (sql: string, name: string) =>
  invoke<DatasetMeta>("create_table_from_sql_query", { sql, name }),
```

Run `npm run build`. Expected: it may pass because IPC names are runtime-bound;
record that this check cannot prove command registration.

- [ ] **Step 2: Add service delegates and thin commands**

Implement `DataService` methods that lock the engine and delegate. Generate a
new UUID only in the service for `create_table_from_sql_query`, matching other
dataset-producing methods.

Add both `#[tauri::command]` functions and register them in
`tauri::generate_handler![...]`.

- [ ] **Step 3: Validate both sides compile**

Run:

```powershell
npm run build
Set-Location src-tauri
cargo build
```

Expected: frontend and backend compile with matching camelCase contracts.

---

### Task 6: SQL Query Dialog And Data Menu

**Files:**
- Create: `src/components/SqlQueryDialog.tsx`
- Create: `src/components/sqlQueryDialog.css`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`

**Interfaces:**
- Consumes: `DatasetMeta[]`, `tableFolders`, and Task 5 service methods
- Produces component: `SqlQueryDialog({ datasets, tableFolders, onClose, onCreated })`
- Produces callback: `onCreated(dataset: DatasetMeta): Promise<void> | void`

- [ ] **Step 1: Build the dialog state and result grid**

Use local state only:

```ts
const [sql, setSql] = useState("");
const [result, setResult] = useState<SqlQueryResult | null>(null);
const [page, setPage] = useState(0);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
const [showCreate, setShowCreate] = useState(false);
const [newTableName, setNewTableName] = useState("");
```

Implement `runQuery(nextPage = 0)` so a new execution clears stale results on
failure, while a failed page request retains the last successful result. Use a
textarea ref and `selectionStart`/`selectionEnd` to insert a quoted table name
at the cursor. Escape any embedded quote as `""`.

Render a table list with folder breadcrumbs, a monospaced editor, Run/Clear/
Create Table/Close controls, a scrollable read-only grid, and fixed pagination
footer. Render null with the localized null token and empty strings as blank
cells. Disable Run, paging, and create controls while busy.

- [ ] **Step 2: Add keyboard and modal behavior**

Handle `Ctrl+Enter`/`Cmd+Enter` inside the editor, Escape to close only when the
name prompt is not active, overlay click to close, and inner click propagation
stop using the existing `sp-dialog-overlay` convention. Give icon buttons
Font Awesome icons and localized tooltips.

- [ ] **Step 3: Implement explicit result-table creation**

Enable Create Table only after a successful result. Propose the first globally
non-conflicting `Query Result`, `Query Result (2)`, ... name using
case-insensitive frontend comparison. Submit through
`createTableFromSqlQuery`; retain SQL and prompt on failure.

On success call `onCreated(meta)`. Workspace must:

```ts
await refreshDatasets();
setActiveGraphBuilderId(null);
setActiveDataset(meta.id);
markDirty();
recordAction(t("history.sqlQueryTableCreated", { name: meta.name }));
setShowSqlQuery(false);
```

- [ ] **Step 4: Add the Data menu and localization**

Add `showSqlQuery` state and place the menu between Table and Graph:

```tsx
<MenuDropdown label={t("menu.data")}>
  <div className="menu-item" onClick={() => setShowSqlQuery(true)}>
    {t("menu.sqlQuery")}
  </div>
</MenuDropdown>
```

Add all dialog labels, statuses, null text, paging text, migration notice, name
validation, DuckDB error headings, and history copy to all four locale files.

- [ ] **Step 5: Add responsive, stable dialog styling**

Use a maximum width/height constrained to the viewport, a fixed-width table
browser, a two-row editor/result grid, stable toolbar button sizes, and
overflow scrolling. At narrow widths stack the table browser above the editor
without allowing labels or buttons to overlap. Reuse existing CSS variables;
do not add a new one-hue palette or nested decorative cards.

- [ ] **Step 6: Run the frontend build immediately after the UI edit**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build pass.

---

### Task 7: End-To-End Regression And Manual Verification

**Files:**
- Modify only files required by failures attributable to Tasks 1-6

**Interfaces:**
- Verifies all produced archive, naming, SQL, IPC, and UI interfaces together

- [ ] **Step 1: Run complete backend verification**

Run:

```powershell
Set-Location src-tauri
cargo test
cargo clippy -- -D warnings
cargo build
```

Expected: all commands exit `0`. Do not fix unrelated pre-existing failures;
record them separately if encountered.

- [ ] **Step 2: Run complete frontend verification**

Run:

```powershell
Set-Location ..
npm run build
```

Expected: TypeScript project build and Vite production bundle succeed.

- [ ] **Step 3: Start the Tauri development app**

Run `npm run tauri dev` as a long-running development process. Verify:

1. Top menu order is File, Table, Data, Graph, Help in English.
2. SQL Query opens and lists visible tables with UI folder breadcrumbs.
3. `SELECT`, CTE, aggregation, and JOIN queries execute by visible table name.
4. Metadata tables, `read_csv`, DDL/DML, and multiple statements show errors.
5. More than 200 results paginate without replacing the page on a failed request.
6. Create Table adds a globally unique query result, selects it, and marks the project dirty.
7. Moving a table folder does not change SQL references.
8. Saving writes ID-based table/graph archive paths and explicit manifest folder maps.
9. Opening a v2 path-based project preserves folder placement.
10. Opening duplicate legacy names migrates them deterministically and reports the migration.

- [ ] **Step 4: Inspect the final diff for scope and secrets**

Confirm the diff contains no absolute user paths, generated build artifacts,
unrelated refactors, or user SQL logging. Confirm all four locales contain the
same new key set and no project table internal UUID is rendered in the dialog.