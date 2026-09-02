//! Spprj archive layer.
//!
//! `.spprj` files are ZIP containers. In v4 the payload layout is flat and
//! name-derived while folder trees remain manifest metadata for the UI:
//!
//! ```text
//! manifest.json                ProjectManifest (project metadata + index)
//! data/<name>.sptb             TableDoc as JSON (one per dataset)
//! data/<name>.spgh             GraphDoc as JSON (one per graph builder)
//! data/<name>.spf              Fit/Tabulate docs (indexed in manifest)
//! snapshots/<name>.json        Snapshot docs (indexed in manifest)
//! .history.json                opaque [HistoryEntry] (optional)
//! .snapshots.json              legacy snapshot fallback (optional)
//! ```
//!
//! v3 and earlier archives may still include legacy logical folder paths.
//! Readers keep backward compatibility, and v4 writes normalize back to the
//! flat layout above.
//!
//! Design principle (issue #7): an `.spprj` is conceptually just a folder of
//! files. The folder a `.sptb` / `.spgh` lives in is encoded ONLY by its
//! archive path — never duplicated inside the file body or as a separate
//! `folder` field on the manifest entry. `manifest.json` is pure metadata:
//! project name, version, created_at, the list of folders that exist
//! (including empty ones), and a `{id → file}` index for tables and graphs.
//!
//! v1 `.spprj` files (`tables/<uuid>.sptb`, `graphs/<uuid>.spgh`, no folders)
//! still open: the reader does NOT migrate at read time. Migration to v2
//! happens implicitly on the next save, when the writer re-derives filenames
//! from display names and lays them out under the user's folder tree.
//!
//! Even older legacy single-file JSON `.spprj` documents are still detected
//! via a first-byte sniff and parsed via `LegacySpprj`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

#[cfg(test)]
type BeforeDestinationMutationHook = Box<dyn Fn(&str, &str) -> Result<(), AppError>>;

#[cfg(test)]
type ValidateTableEntryOpenHook = Box<dyn Fn(&str, u64, u64) -> Result<(), AppError>>;

#[cfg(test)]
thread_local! {
    static BEFORE_DESTINATION_MUTATION_HOOK: std::cell::RefCell<Option<BeforeDestinationMutationHook>> =
        std::cell::RefCell::new(None);
    static VALIDATE_TABLE_ENTRY_OPEN_HOOK: std::cell::RefCell<Option<ValidateTableEntryOpenHook>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(crate) fn install_test_before_destination_mutation_hook(
    hook: Option<BeforeDestinationMutationHook>,
) {
    BEFORE_DESTINATION_MUTATION_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
pub(crate) fn install_test_validate_table_entry_open_hook(
    hook: Option<ValidateTableEntryOpenHook>,
) {
    VALIDATE_TABLE_ENTRY_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = hook;
    });
}

#[cfg(test)]
fn run_before_destination_mutation_hook(path: &str, tmp_path: &str) -> Result<(), AppError> {
    BEFORE_DESTINATION_MUTATION_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(path, tmp_path)?;
        }
        Ok(())
    })
}

#[cfg(test)]
fn run_validate_table_entry_open_hook(
    entry_name: &str,
    entry_size: u64,
    body_bytes_read: u64,
) -> Result<(), AppError> {
    VALIDATE_TABLE_ENTRY_OPEN_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(entry_name, entry_size, body_bytes_read)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn run_validate_table_entry_open_hook(
    _entry_name: &str,
    _entry_size: u64,
    _body_bytes_read: u64,
) -> Result<(), AppError> {
    Ok(())
}

#[cfg(not(test))]
fn run_before_destination_mutation_hook(_path: &str, _tmp_path: &str) -> Result<(), AppError> {
    Ok(())
}

// ----------------------------------------------------------------------------
// Public document types — these are the in-memory representation. The on-disk
// JSON shape mirrors the field names exactly (camelCase via serde rename).
// ----------------------------------------------------------------------------

/// The top-level index for a `.spprj` archive. Stored as `manifest.json`.
///
/// Per-dataset and per-graph payloads are NOT inlined here — they live in
/// separate ZIP entries pointed to by `tables` / `graphs` relative paths. This
/// is what enables "open just one table" and "share a single graph" workflows.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub name: String,
    pub version: String,
    pub created_at: String,
    /// Index of table entries.
    #[serde(default)]
    pub tables: Vec<TableEntryRef>,
    /// Index of graph entries.
    #[serde(default)]
    pub graphs: Vec<GraphEntryRef>,
    /// All folders that exist in the project, including empty ones.
    /// Paths use `/` as the separator and never start or end with `/`.
    /// Implicit ancestors (e.g. `a` for `a/b`) are still listed explicitly.
    #[serde(default)]
    pub folders: Vec<String>,
    /// `tableId -> folder path` manifest metadata. Missing means a legacy
    /// archive whose folder layout must be derived from entry paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_folders: Option<HashMap<String, String>>,
    /// `graphId -> folder path` manifest metadata. Missing means a legacy
    /// archive whose folder layout must be derived from entry paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_folders: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fit_y_by_x: Vec<serde_json::Value>,
    #[serde(default)]
    pub fit_y_by_x_folders: HashMap<String, String>,
    #[serde(default)]
    pub report_folders: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tabulates: Vec<serde_json::Value>,
    #[serde(default)]
    pub tabulate_folders: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub report_files: Vec<DocumentEntryRef>,
    #[serde(default)]
    pub fit_y_by_x_files: Vec<DocumentEntryRef>,
    #[serde(default)]
    pub tabulate_files: Vec<DocumentEntryRef>,
    #[serde(default)]
    pub snapshot_files: Vec<SnapshotEntryRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocumentKind {
    FitYByX,
    Report,
    Tabulate,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntryRef {
    pub id: String,
    pub name: String,
    pub file: String,
    pub kind: DocumentKind,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntryRef {
    pub id: String,
    pub name: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableEntryRef {
    pub id: String,
    pub name: String,
    /// Relative path inside the archive — for v2 this is `<folder>/<name>.sptb`
    /// (or `<name>.sptb` at the root). For v1 reads this stays `tables/<id>.sptb`.
    /// The folder is derived from `dirname(file)` on read; never duplicated here.
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntryRef {
    pub id: String,
    /// Display name of the graph, used to derive the archive filename in v2.
    /// v1 manifests didn't have this — defaults to empty string then.
    #[serde(default)]
    pub name: String,
    /// Relative path inside the archive, e.g. `<folder>/<name>.spgh`.
    /// The folder is derived from `dirname(file)` on read; never duplicated here.
    pub file: String,
}

/// One table file (`.sptb`). Self-contained: includes its own id/name so that
/// importing a standalone `.sptb` back into a project doesn't lose anything.
/// Per issue #7, this body does NOT carry folder information — a file is
/// just a file; where it lives is the folder it sits in.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableDoc {
    pub id: String,
    pub name: String,
    pub source_type: String,
    /// Doc format version — bump if the rows/columns shape changes.
    #[serde(default = "default_doc_version")]
    pub version: String,
    pub columns: Vec<TableColumn>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    pub col_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<TableColumnFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<BTreeMap<String, Value>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnFormat {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// One graph file (`.spgh`). The body is opaque JSON owned by the frontend
/// (graph builder config). We require an `id` field at the top level so the
/// manifest can index it; `name` is pulled into the named field so the writer
/// can build the archive path. Per issue #7, folder info is NOT carried here.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphDoc {
    pub id: String,
    /// Display name — used to derive the `<name>.spgh` filename in v2.
    /// Defaults to empty (the writer falls back to the id then).
    #[serde(default)]
    pub name: String,
    /// Doc format version.
    #[serde(default = "default_doc_version")]
    pub version: String,
    /// Frontend-owned opaque payload (everything except the named fields).
    #[serde(flatten)]
    pub body: serde_json::Map<String, Value>,
}

fn default_doc_version() -> String {
    "1".to_string()
}

// ----------------------------------------------------------------------------
// Bundle = the in-memory shape of an entire project, ready to write or just
// loaded from disk. project_service.rs builds this when saving and consumes
// it when loading.
// ----------------------------------------------------------------------------

#[derive(Clone)]
pub struct ProjectBundle {
    pub manifest: ProjectManifest,
    pub tables: Vec<TableDoc>,
    pub graphs: Vec<GraphDoc>,
    pub fit_y_by_x: Vec<Value>,
    pub reports: Vec<Value>,
    pub tabulates: Vec<Value>,
    pub history: Vec<Value>,
    pub snapshots: Vec<Value>,
}

// ----------------------------------------------------------------------------
// Legacy single-file `.spprj` JSON format. We keep the old shape verbatim so
// that existing project files on disk still open. New saves always emit the
// new ZIP format.
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySpprj {
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    datasets: Vec<LegacyDataset>,
    #[serde(default)]
    history: Option<Vec<Value>>,
    #[serde(default)]
    snapshots: Option<Vec<Value>>,
    #[serde(default)]
    graph_builders: Option<Vec<Value>>,
    #[serde(default)]
    fit_y_by_x: Option<Vec<Value>>,
    #[serde(default)]
    fit_y_by_x_folders: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDataset {
    id: String,
    name: String,
    #[serde(default)]
    source_type: String,
    columns: Vec<TableColumn>,
    rows: Vec<Vec<Value>>,
}

// ----------------------------------------------------------------------------
// Read API
// ----------------------------------------------------------------------------

/// Sniff the first bytes of a file and decide whether it is a ZIP archive
/// (new format) or a JSON document (legacy).
pub fn read_project_file(path: &str) -> Result<ProjectBundle, AppError> {
    let bytes = std::fs::read(path)?;
    if is_zip(&bytes) {
        read_zip_bundle(&bytes)
    } else {
        read_legacy_json(&bytes)
    }
}

pub fn build_graph_docs(raw_graph_builders: Vec<Value>) -> Vec<GraphDoc> {
    raw_graph_builders
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let (id, name, body) = lift_id_name(raw, index);
            GraphDoc {
                id,
                name,
                version: default_doc_version(),
                body,
            }
        })
        .collect()
}

pub fn validate_archive_manifest_and_entries(
    archive_path: &Path,
    expected_manifest: &ProjectManifest,
    expected_extra_entries: &[&str],
) -> Result<(), AppError> {
    let file = std::fs::File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive during validation: {e}")))?;

    let mut manifest_entry = zip
        .by_name("manifest.json")
        .map_err(|e| AppError::FileIO(format!("Project archive missing manifest.json: {e}")))?;
    let mut manifest_bytes = Vec::new();
    manifest_entry
        .read_to_end(&mut manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Failed reading manifest.json: {e}")))?;
    drop(manifest_entry);

    let actual_manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json during validation: {e}")))?;

    let expected_json = serde_json::to_value(expected_manifest)
        .map_err(|e| AppError::FileIO(format!("Failed to encode expected manifest: {e}")))?;
    let actual_json = serde_json::to_value(&actual_manifest)
        .map_err(|e| AppError::FileIO(format!("Failed to encode actual manifest: {e}")))?;
    if expected_json != actual_json {
        return Err(AppError::FileIO(
            "Validated archive manifest differs from expected snapshot".to_string(),
        ));
    }

    validate_manifest_entry_refs(expected_manifest)?;
    let strict_v4_name_checks = is_format_v4(&expected_manifest.version);

    for table in &expected_manifest.tables {
        let table_entry = zip.by_name(&table.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing table entry {}: {e}", table.file))
        })?;
        run_validate_table_entry_open_hook(&table.file, table_entry.size(), 0)?;
        drop(table_entry);
    }
    for graph in &expected_manifest.graphs {
        let mut graph_entry = zip.by_name(&graph.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing graph entry {}: {e}", graph.file))
        })?;
        let mut graph_bytes = Vec::new();
        graph_entry.read_to_end(&mut graph_bytes).map_err(|e| {
            AppError::FileIO(format!("Failed reading graph entry {}: {e}", graph.file))
        })?;
        let doc = parse_graph_doc(&graph_bytes, &graph.id).map_err(|e| {
            AppError::FileIO(format!(
                "Archive graph entry {} is invalid: {e}",
                graph.file
            ))
        })?;
        if doc.id != graph.id {
            return Err(AppError::FileIO(format!(
                "Archive graph id mismatch in {}: manifest={}, body={}",
                graph.file, graph.id, doc.id
            )));
        }
        if strict_v4_name_checks && doc.name != graph.name {
            return Err(AppError::FileIO(format!(
                "Archive graph name mismatch in {}: manifest={}, body={}",
                graph.file, graph.name, doc.name
            )));
        }
    }
    for entry in &expected_manifest.report_files {
        let mut doc_entry = zip.by_name(&entry.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing report entry {}: {e}", entry.file))
        })?;
        let value: Value = serde_json::from_reader(&mut doc_entry).map_err(|e| {
            AppError::FileIO(format!(
                "Archive report entry {} is not valid JSON: {e}",
                entry.file
            ))
        })?;
        validate_report_value(&value, &entry.file)?;
        let body_id = value.get("id").and_then(Value::as_str).ok_or_else(|| {
            AppError::FileIO(format!("Archive report entry {} missing id", entry.file))
        })?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Archive report id mismatch in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "report")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Archive report name mismatch in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
    }
    for entry in &expected_manifest.fit_y_by_x_files {
        let mut doc_entry = zip.by_name(&entry.file).map_err(|e| {
            AppError::FileIO(format!("Archive missing fit entry {}: {e}", entry.file))
        })?;
        let value: Value = serde_json::from_reader(&mut doc_entry).map_err(|e| {
            AppError::FileIO(format!(
                "Archive fit entry {} is not valid JSON: {e}",
                entry.file
            ))
        })?;
        let body_id = value.get("id").and_then(Value::as_str).ok_or_else(|| {
            AppError::FileIO(format!("Archive fit entry {} missing id", entry.file))
        })?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Archive fit id mismatch in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "fit")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Archive fit name mismatch in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
    }
    for entry in &expected_manifest.tabulate_files {
        let mut doc_entry = zip.by_name(&entry.file).map_err(|e| {
            AppError::FileIO(format!(
                "Archive missing tabulate entry {}: {e}",
                entry.file
            ))
        })?;
        let value: Value = serde_json::from_reader(&mut doc_entry).map_err(|e| {
            AppError::FileIO(format!(
                "Archive tabulate entry {} is not valid JSON: {e}",
                entry.file
            ))
        })?;
        let body_id = value.get("id").and_then(Value::as_str).ok_or_else(|| {
            AppError::FileIO(format!("Archive tabulate entry {} missing id", entry.file))
        })?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Archive tabulate id mismatch in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "tabulate")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Archive tabulate name mismatch in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
    }
    for entry in &expected_manifest.snapshot_files {
        let mut doc_entry = zip.by_name(&entry.file).map_err(|e| {
            AppError::FileIO(format!(
                "Archive missing snapshot entry {}: {e}",
                entry.file
            ))
        })?;
        let value: Value = serde_json::from_reader(&mut doc_entry).map_err(|e| {
            AppError::FileIO(format!(
                "Archive snapshot entry {} is not valid JSON: {e}",
                entry.file
            ))
        })?;
        let body_id = value.get("id").and_then(Value::as_str).ok_or_else(|| {
            AppError::FileIO(format!("Archive snapshot entry {} missing id", entry.file))
        })?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Archive snapshot id mismatch in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "snapshot")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Archive snapshot name mismatch in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
    }
    for entry in expected_extra_entries {
        let mut extra_entry = zip
            .by_name(entry)
            .map_err(|e| AppError::FileIO(format!("Archive missing entry {}: {e}", entry)))?;
        serde_json::from_reader::<_, serde::de::IgnoredAny>(&mut extra_entry).map_err(|e| {
            AppError::FileIO(format!("Archive entry {} is not valid JSON: {e}", entry))
        })?;
    }

    Ok(())
}

pub fn count_project_rows_streaming(path: &str) -> Result<usize, AppError> {
    let bytes = std::fs::read(path)?;
    if !is_zip(&bytes) {
        let bundle = read_legacy_json(&bytes)?;
        return Ok(bundle.tables.iter().map(|table| table.rows.len()).sum());
    }

    let cursor = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive: {e}")))?;

    let manifest_bytes = read_entry_bytes(&mut zip, "manifest.json")
        .ok_or_else(|| AppError::FileIO("Project archive missing manifest.json".into()))?;
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json: {e}")))?;

    let mut total_rows = 0usize;
    for table in manifest.tables {
        let mut table_entry = zip
            .by_name(&table.file)
            .map_err(|e| AppError::FileIO(format!("Missing table entry: {} ({e})", table.file)))?;
        total_rows = total_rows.saturating_add(count_rows_in_table_json(&mut table_entry)?);
    }

    Ok(total_rows)
}

fn count_rows_in_table_json<R: Read>(reader: R) -> Result<usize, AppError> {
    struct RowsCountSeed;

    impl<'de> DeserializeSeed<'de> for RowsCountSeed {
        type Value = usize;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct RowsVisitor;

            impl<'de> Visitor<'de> for RowsVisitor {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("a JSON array of table rows")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while seq.next_element::<IgnoredAny>()?.is_some() {
                        count = count.saturating_add(1);
                    }
                    Ok(count)
                }
            }

            deserializer.deserialize_seq(RowsVisitor)
        }
    }

    struct TableVisitor;

    impl<'de> Visitor<'de> for TableVisitor {
        type Value = usize;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a table JSON object")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut rows_count: Option<usize> = None;
            while let Some(key) = map.next_key::<String>()? {
                if key == "rows" {
                    rows_count = Some(map.next_value_seed(RowsCountSeed)?);
                } else {
                    let _: IgnoredAny = map.next_value()?;
                }
            }
            rows_count.ok_or_else(|| serde::de::Error::missing_field("rows"))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let row_count = serde::de::Deserializer::deserialize_any(&mut deserializer, TableVisitor)
        .map_err(|e| AppError::FileIO(format!("Invalid table JSON while counting rows: {e}")))?;
    deserializer
        .end()
        .map_err(|e| AppError::FileIO(format!("Trailing table JSON content: {e}")))?;
    Ok(row_count)
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..2] == b"PK"
}

fn read_zip_bundle(bytes: &[u8]) -> Result<ProjectBundle, AppError> {
    let cursor = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::FileIO(format!("Invalid project archive: {}", e)))?;

    let manifest_bytes = read_entry_bytes(&mut zip, "manifest.json")
        .ok_or_else(|| AppError::FileIO("Project archive missing manifest.json".into()))?;
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid manifest.json: {}", e)))?;

    validate_manifest_entry_refs(&manifest)?;
    let strict_v4_name_checks = is_format_v4(&manifest.version);

    let mut tables = Vec::with_capacity(manifest.tables.len());
    for entry in &manifest.tables {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing table entry: {}", entry.file)))?;
        let doc: TableDoc = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::FileIO(format!("Invalid table file {}: {}", entry.file, e)))?;
        if doc.id != entry.id {
            return Err(AppError::FileIO(format!(
                "Mismatched table id in {}: manifest={}, body={}",
                entry.file, entry.id, doc.id
            )));
        }
        if strict_v4_name_checks && doc.name != entry.name {
            return Err(AppError::FileIO(format!(
                "Mismatched table name in {}: manifest={}, body={}",
                entry.file, entry.name, doc.name
            )));
        }
        tables.push(doc);
    }
    let mut graphs = Vec::with_capacity(manifest.graphs.len());
    for entry in &manifest.graphs {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing graph entry: {}", entry.file)))?;
        let doc = parse_graph_doc(&bytes, &entry.id)
            .map_err(|e| AppError::FileIO(format!("Invalid graph file {}: {}", entry.file, e)))?;
        if doc.id != entry.id {
            return Err(AppError::FileIO(format!(
                "Mismatched graph id in {}: manifest={}, body={}",
                entry.file, entry.id, doc.id
            )));
        }
        if strict_v4_name_checks && doc.name != entry.name {
            return Err(AppError::FileIO(format!(
                "Mismatched graph name in {}: manifest={}, body={}",
                entry.file, entry.name, doc.name
            )));
        }
        graphs.push(doc);
    }

    let history = read_entry_bytes(&mut zip, ".history.json")
        .or_else(|| read_entry_bytes(&mut zip, "history.json"))
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let fit_y_by_x = if !manifest.fit_y_by_x_files.is_empty() {
        read_indexed_values(
            &mut zip,
            &manifest.fit_y_by_x_files,
            DocumentKind::FitYByX,
            strict_v4_name_checks,
        )?
    } else {
        manifest.fit_y_by_x.clone()
    };
    let reports = if !manifest.report_files.is_empty() {
        read_indexed_values(
            &mut zip,
            &manifest.report_files,
            DocumentKind::Report,
            strict_v4_name_checks,
        )?
    } else {
        Vec::new()
    };
    let tabulates = if !manifest.tabulate_files.is_empty() {
        read_indexed_values(
            &mut zip,
            &manifest.tabulate_files,
            DocumentKind::Tabulate,
            strict_v4_name_checks,
        )?
    } else {
        manifest.tabulates.clone()
    };
    let snapshots = if !manifest.snapshot_files.is_empty() {
        read_indexed_snapshots(&mut zip, &manifest.snapshot_files, strict_v4_name_checks)?
    } else {
        read_entry_bytes(&mut zip, ".snapshots.json")
            .or_else(|| read_entry_bytes(&mut zip, "snapshots.json"))
            .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
            .unwrap_or_default()
    };

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        fit_y_by_x,
        reports,
        tabulates,
        history,
        snapshots,
    })
}

fn read_indexed_values<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    refs: &[DocumentEntryRef],
    expected_kind: DocumentKind,
    strict_v4_name_checks: bool,
) -> Result<Vec<Value>, AppError> {
    let mut out = Vec::with_capacity(refs.len());
    for entry in refs {
        if entry.kind != expected_kind {
            return Err(AppError::FileIO(format!(
                "Mismatched document kind in {}",
                entry.file
            )));
        }
        let bytes = read_entry_bytes(zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing indexed entry: {}", entry.file)))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::FileIO(format!("Invalid indexed file {}: {}", entry.file, e)))?;
        if expected_kind == DocumentKind::Report {
            validate_report_value(&value, &entry.file)?;
        }
        let body_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::FileIO(format!("Indexed file {} missing id", entry.file)))?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Mismatched document id in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "document")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Mismatched document name in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
        out.push(value);
    }
    Ok(out)
}

fn read_indexed_snapshots<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    refs: &[SnapshotEntryRef],
    strict_v4_name_checks: bool,
) -> Result<Vec<Value>, AppError> {
    let mut out = Vec::with_capacity(refs.len());
    for entry in refs {
        let bytes = read_entry_bytes(zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing indexed entry: {}", entry.file)))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::FileIO(format!("Invalid indexed file {}: {}", entry.file, e)))?;
        let body_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::FileIO(format!("Indexed file {} missing id", entry.file)))?;
        if body_id != entry.id {
            return Err(AppError::FileIO(format!(
                "Mismatched snapshot id in {}: manifest={}, body={}",
                entry.file, entry.id, body_id
            )));
        }
        if strict_v4_name_checks {
            let body_name = value_required_name(&value, &entry.file, "snapshot")?;
            if body_name != entry.name {
                return Err(AppError::FileIO(format!(
                    "Mismatched snapshot name in {}: manifest={}, body={}",
                    entry.file, entry.name, body_name
                )));
            }
        }
        out.push(value);
    }
    Ok(out)
}

fn read_entry_bytes<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut entry = zip.by_name(name).ok()?;
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out).ok()?;
    Some(out)
}

fn read_legacy_json(bytes: &[u8]) -> Result<ProjectBundle, AppError> {
    let legacy: LegacySpprj = serde_json::from_slice(bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid project file: {}", e)))?;

    // v0 (legacy single-file JSON) had no folder concept — every table /
    // graph lives at the project root. Synthesize root-level paths so the
    // path-derived folder logic in open_project naturally returns `None`.
    let mut tables = Vec::with_capacity(legacy.datasets.len());
    let mut table_refs = Vec::with_capacity(legacy.datasets.len());
    for ds in legacy.datasets {
        table_refs.push(TableEntryRef {
            id: ds.id.clone(),
            name: ds.name.clone(),
            file: format!("{}.sptb", ds.id),
        });
        tables.push(TableDoc {
            id: ds.id,
            name: ds.name,
            source_type: ds.source_type,
            version: default_doc_version(),
            columns: ds.columns,
            rows: ds.rows,
        });
    }

    // Legacy graph builders had no top-level id field separate from the body.
    // Try to lift `id`/`builderId`/`name` out for the manifest; otherwise synthesize.
    let mut graphs = Vec::new();
    let mut graph_refs = Vec::new();
    if let Some(gbs) = legacy.graph_builders {
        for (idx, raw) in gbs.into_iter().enumerate() {
            let (id, name, body) = lift_id_name(raw, idx);
            graph_refs.push(GraphEntryRef {
                id: id.clone(),
                name: name.clone(),
                file: format!("{}.spgh", id),
            });
            graphs.push(GraphDoc {
                id,
                name,
                version: default_doc_version(),
                body,
            });
        }
    }

    let fit_y_by_x = legacy.fit_y_by_x.unwrap_or_default();
    let fit_y_by_x_folders = legacy.fit_y_by_x_folders.unwrap_or_default();

    let manifest = ProjectManifest {
        name: legacy.name,
        version: if legacy.version.is_empty() {
            "0.1.0".into()
        } else {
            legacy.version
        },
        created_at: legacy.created_at,
        tables: table_refs,
        graphs: graph_refs,
        folders: Vec::new(),
        table_folders: None,
        graph_folders: None,
        fit_y_by_x: fit_y_by_x.clone(),
        fit_y_by_x_folders,
        report_folders: HashMap::new(),
        tabulates: Vec::new(),
        tabulate_folders: HashMap::new(),
        report_files: Vec::new(),
        fit_y_by_x_files: Vec::new(),
        tabulate_files: Vec::new(),
        snapshot_files: Vec::new(),
    };

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        fit_y_by_x,
        reports: Vec::new(),
        tabulates: Vec::new(),
        history: legacy.history.unwrap_or_default(),
        snapshots: legacy.snapshots.unwrap_or_default(),
    })
}

/// Pull `id` and `name` out of an opaque graph builder JSON value for use in
/// the manifest, returning `(id, name, body)`. `id`, `name`, `version`, and
/// any legacy `folder` field are *removed* from the returned body so the
/// GraphDoc that flattens it won't emit duplicate keys on serialization, and
/// so legacy in-body folder hints can never silently override the
/// path-derived folder.
fn lift_id_name(
    raw: Value,
    fallback_idx: usize,
) -> (String, String, serde_json::Map<String, Value>) {
    let mut map = match raw {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            map.remove("builderId")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_else(|| format!("graph_{}", fallback_idx));
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    map.remove("version");
    map.remove("folder"); // legacy: drop in-body folder; archive path is the source of truth.
    (id, name, map)
}

// ----------------------------------------------------------------------------
// Write API
// ----------------------------------------------------------------------------

/// Build a `ProjectBundle` from per-doc inputs.
///
/// Folder routing is supplied OUT-OF-BAND via `table_folders` and
/// `graph_folders` (id → folder path); per issue #7 the file bodies
/// themselves carry no folder information. In v4, writer paths are flat and
/// name-derived under `data/` and `snapshots/`; legacy manifests remain
/// readable for backward compatibility.
pub fn build_bundle(
    name: String,
    version: String,
    created_at: String,
    tables: Vec<TableDoc>,
    graphs: Vec<GraphDoc>,
    fit_y_by_x: Vec<Value>,
    reports: Vec<Value>,
    tabulates: Vec<Value>,
    folders: Vec<String>,
    table_folders: &HashMap<String, String>,
    graph_folders: &HashMap<String, String>,
    fit_y_by_x_folders: &HashMap<String, String>,
    report_folders: &HashMap<String, String>,
    tabulate_folders: &HashMap<String, String>,
    history: Vec<Value>,
    snapshots: Vec<Value>,
) -> Result<ProjectBundle, AppError> {
    let mut tables = tables;
    let mut graphs = graphs;
    let mut fit_y_by_x: Vec<Value> = fit_y_by_x
        .into_iter()
        .map(strip_transient_fit_y_by_x_fields)
        .collect();
    let mut reports = reports;
    let mut tabulates = tabulates;
    let mut snapshots = snapshots;

    {
        let mut table_ids = HashSet::new();
        for doc in &tables {
            ensure_unique_bundle_id(&mut table_ids, &doc.id, "table")?;
        }
        let mut graph_ids = HashSet::new();
        for doc in &graphs {
            ensure_unique_bundle_id(&mut graph_ids, &doc.id, "graph")?;
        }
        let mut fit_ids = HashSet::new();
        let mut tabulate_ids = HashSet::new();
        let mut active_document_ids = HashSet::new();
        for doc in &fit_y_by_x {
            let id = value_required_id(doc, "fitYByX")?;
            ensure_unique_bundle_id(&mut fit_ids, &id, "fitYByX")?;
            ensure_unique_bundle_id(&mut active_document_ids, &id, "active document")?;
        }
        let mut report_ids = HashSet::new();
        for doc in &reports {
            validate_report_value(doc, "build bundle report")?;
            let id = value_required_id(doc, "report")?;
            ensure_unique_bundle_id(&mut report_ids, &id, "report")?;
        }
        for doc in &tabulates {
            let id = value_required_id(doc, "tabulate")?;
            ensure_unique_bundle_id(&mut tabulate_ids, &id, "tabulate")?;
            ensure_unique_bundle_id(&mut active_document_ids, &id, "active document")?;
        }
        let mut snapshot_ids = HashSet::new();
        for doc in &snapshots {
            let id = value_required_id(doc, "snapshot")?;
            ensure_unique_bundle_id(&mut snapshot_ids, &id, "snapshot")?;
        }
    }

    let mut used_table_paths: HashSet<String> = HashSet::new();
    let mut used_graph_paths: HashSet<String> = HashSet::new();
    let mut used_data_spf_paths: HashSet<String> = HashSet::new();
    let mut used_report_paths: HashSet<String> = HashSet::new();
    let mut used_snapshot_json_paths: HashSet<String> = HashSet::new();

    let mut table_refs: Vec<TableEntryRef> = Vec::with_capacity(tables.len());
    for t in &mut tables {
        let (resolved_name, resolved_file) =
            allocate_archive_name(&t.name, &t.id, ".sptb", "data", &mut used_table_paths)?;
        t.name = resolved_name.clone();
        table_refs.push(TableEntryRef {
            id: t.id.clone(),
            name: resolved_name,
            file: resolved_file,
        });
    }

    let mut graph_refs: Vec<GraphEntryRef> = Vec::with_capacity(graphs.len());
    for g in &mut graphs {
        let (resolved_name, resolved_file) =
            allocate_archive_name(&g.name, &g.id, ".spgh", "data", &mut used_graph_paths)?;
        g.name = resolved_name.clone();
        graph_refs.push(GraphEntryRef {
            id: g.id.clone(),
            name: resolved_name,
            file: resolved_file,
        });
    }

    let mut fit_y_by_x_refs: Vec<DocumentEntryRef> = Vec::with_capacity(fit_y_by_x.len());
    for fit in &mut fit_y_by_x {
        let fit_id = value_required_id(fit, "fitYByX")?;
        let fit_name = value_name_or_fallback(fit, &fit_id);
        let (resolved_name, resolved_file) =
            allocate_archive_name(&fit_name, &fit_id, ".spf", "data", &mut used_data_spf_paths)?;
        set_value_name(fit, &resolved_name, "fitYByX")?;
        fit_y_by_x_refs.push(DocumentEntryRef {
            id: fit_id,
            name: resolved_name,
            file: resolved_file,
            kind: DocumentKind::FitYByX,
        });
    }

    let mut report_refs: Vec<DocumentEntryRef> = Vec::with_capacity(reports.len());
    for report in &mut reports {
        validate_report_value(report, "build bundle report")?;
        let report_id = value_required_id(report, "report")?;
        let report_name = value_name_or_fallback(report, &report_id);
        let (resolved_name, resolved_file) = allocate_archive_name(
            &report_name,
            &report_id,
            ".sprp",
            "data",
            &mut used_report_paths,
        )?;
        set_value_name(report, &resolved_name, "report")?;
        report_refs.push(DocumentEntryRef {
            id: report_id,
            name: resolved_name,
            file: resolved_file,
            kind: DocumentKind::Report,
        });
    }

    let mut tabulate_refs: Vec<DocumentEntryRef> = Vec::with_capacity(tabulates.len());
    for tabulate in &mut tabulates {
        let tabulate_id = value_required_id(tabulate, "tabulate")?;
        let tabulate_name = value_name_or_fallback(tabulate, &tabulate_id);
        let (resolved_name, resolved_file) = allocate_archive_name(
            &tabulate_name,
            &tabulate_id,
            ".spf",
            "data",
            &mut used_data_spf_paths,
        )?;
        set_value_name(tabulate, &resolved_name, "tabulate")?;
        tabulate_refs.push(DocumentEntryRef {
            id: tabulate_id,
            name: resolved_name,
            file: resolved_file,
            kind: DocumentKind::Tabulate,
        });
    }

    let mut snapshot_refs: Vec<SnapshotEntryRef> = Vec::with_capacity(snapshots.len());
    for snapshot in &mut snapshots {
        let snapshot_id = value_required_id(snapshot, "snapshot")?;
        let snapshot_name = value_name_or_fallback(snapshot, &snapshot_id);
        let (resolved_name, resolved_file) = allocate_archive_name(
            &snapshot_name,
            &snapshot_id,
            ".json",
            "snapshots",
            &mut used_snapshot_json_paths,
        )?;
        set_value_name(snapshot, &resolved_name, "snapshot")?;
        snapshot_refs.push(SnapshotEntryRef {
            id: snapshot_id,
            name: resolved_name,
            file: resolved_file,
        });
    }

    // Collapse `folders` to a sorted, deduplicated, normalized list. Includes
    // any implicit ancestor folders for completeness so an extractor sees the
    // full tree even if the user only created `a/b/c` directly.
    let normalized_folders = normalize_folder_list(folders);

    let manifest_fit_y_by_x = if is_format_v4(&version) {
        Vec::new()
    } else {
        fit_y_by_x.clone()
    };
    let manifest_tabulates = if is_format_v4(&version) {
        Vec::new()
    } else {
        tabulates.clone()
    };

    Ok(ProjectBundle {
        manifest: ProjectManifest {
            name,
            version,
            created_at,
            tables: table_refs,
            graphs: graph_refs,
            folders: normalized_folders,
            table_folders: Some(table_folders.clone()),
            graph_folders: Some(graph_folders.clone()),
            fit_y_by_x: manifest_fit_y_by_x,
            fit_y_by_x_folders: fit_y_by_x_folders.clone(),
            report_folders: report_folders.clone(),
            tabulates: manifest_tabulates,
            tabulate_folders: tabulate_folders.clone(),
            report_files: report_refs,
            fit_y_by_x_files: fit_y_by_x_refs,
            tabulate_files: tabulate_refs,
            snapshot_files: snapshot_refs,
        },
        tables,
        graphs,
        fit_y_by_x,
        reports,
        tabulates,
        history,
        snapshots,
    })
}

fn strip_transient_fit_y_by_x_fields(value: Value) -> Value {
    match value {
        Value::Object(mut map) => {
            map.remove("result");
            map.remove("reportState");
            Value::Object(map)
        }
        other => other,
    }
}

/// Write a `ProjectBundle` to disk as a zip archive at `path`.
///
/// Strategy: write to `<path>.tmp` first, then rename over the original. Gives
/// us a much safer path than a direct in-place overwrite on Windows.
pub fn write_project_archive(bundle: &ProjectBundle, path: &str) -> Result<(), AppError> {
    validate_bundle_before_write(bundle)?;

    let tmp_path = format!("{}.tmp", path);
    let write_result = (|| -> Result<(), AppError> {
        let file = std::fs::File::create(&tmp_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let dir_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let write_v4_flat = is_format_v4(&bundle.manifest.version);

        write_zip_json_entry_pretty(&mut zip, "manifest.json", &bundle.manifest, opts)?;

        if !write_v4_flat {
            // Older bundles keep explicit directories so extraction preserves
            // the legacy logical tree. v4 intentionally writes a flat payload layout.
            let mut all_dirs: HashSet<String> = HashSet::new();
            for f in &bundle.manifest.folders {
                for anc in folder_ancestors(f) {
                    all_dirs.insert(anc);
                }
            }
            for t in &bundle.manifest.tables {
                if let Some(parent) = parent_folder(&t.file) {
                    for anc in folder_ancestors(&parent) {
                        all_dirs.insert(anc);
                    }
                }
            }
            for g in &bundle.manifest.graphs {
                if let Some(parent) = parent_folder(&g.file) {
                    for anc in folder_ancestors(&parent) {
                        all_dirs.insert(anc);
                    }
                }
            }
            let mut dirs_sorted: Vec<String> = all_dirs.into_iter().collect();
            dirs_sorted.sort();
            for d in &dirs_sorted {
                zip.add_directory(format!("{}/", d), dir_opts)
                    .map_err(|e| AppError::FileIO(e.to_string()))?;
            }
        }

        // Map each TableDoc / GraphDoc by id so we can pair them with the
        // manifest entry that holds the authoritative archive path.
        let table_by_id: HashMap<&str, &TableDoc> =
            bundle.tables.iter().map(|t| (t.id.as_str(), t)).collect();
        let graph_by_id: HashMap<&str, &GraphDoc> =
            bundle.graphs.iter().map(|g| (g.id.as_str(), g)).collect();
        let fit_by_id: HashMap<&str, &Value> = bundle
            .fit_y_by_x
            .iter()
            .filter_map(|value| {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id, value))
            })
            .collect();
        let report_by_id: HashMap<&str, &Value> = bundle
            .reports
            .iter()
            .filter_map(|value| {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id, value))
            })
            .collect();
        let tabulate_by_id: HashMap<&str, &Value> = bundle
            .tabulates
            .iter()
            .filter_map(|value| {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id, value))
            })
            .collect();
        let snapshot_by_id: HashMap<&str, &Value> = bundle
            .snapshots
            .iter()
            .filter_map(|value| {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id, value))
            })
            .collect();

        for entry in &bundle.manifest.tables {
            let doc = table_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing table payload for manifest reference {}",
                    entry.id
                ))
            })?;
            write_zip_json_entry(&mut zip, &entry.file, doc, opts)?;
        }
        for entry in &bundle.manifest.graphs {
            let doc = graph_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing graph payload for manifest reference {}",
                    entry.id
                ))
            })?;
            write_zip_json_entry(&mut zip, &entry.file, doc, opts)?;
        }
        for entry in &bundle.manifest.fit_y_by_x_files {
            let doc = fit_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing fit payload for manifest reference {}",
                    entry.id
                ))
            })?;
            let synced = indexed_payload_with_manifest_name(doc, &entry.id, &entry.name, "fit")?;
            write_zip_json_entry(&mut zip, &entry.file, &synced, opts)?;
        }
        for entry in &bundle.manifest.report_files {
            let doc = report_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing report payload for manifest reference {}",
                    entry.id
                ))
            })?;
            let synced = indexed_payload_with_manifest_name(doc, &entry.id, &entry.name, "report")?;
            write_zip_json_entry(&mut zip, &entry.file, &synced, opts)?;
        }
        for entry in &bundle.manifest.tabulate_files {
            let doc = tabulate_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing tabulate payload for manifest reference {}",
                    entry.id
                ))
            })?;
            let synced =
                indexed_payload_with_manifest_name(doc, &entry.id, &entry.name, "tabulate")?;
            write_zip_json_entry(&mut zip, &entry.file, &synced, opts)?;
        }
        for entry in &bundle.manifest.snapshot_files {
            let doc = snapshot_by_id.get(entry.id.as_str()).ok_or_else(|| {
                AppError::FileIO(format!(
                    "missing snapshot payload for manifest reference {}",
                    entry.id
                ))
            })?;
            let synced =
                indexed_payload_with_manifest_name(doc, &entry.id, &entry.name, "snapshot")?;
            write_zip_json_entry(&mut zip, &entry.file, &synced, opts)?;
        }
        if !bundle.history.is_empty() {
            write_zip_json_entry(&mut zip, ".history.json", &bundle.history, opts)?;
        }
        if bundle.manifest.snapshot_files.is_empty() && !bundle.snapshots.is_empty() {
            write_zip_json_entry(&mut zip, ".snapshots.json", &bundle.snapshots, opts)?;
        }
        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    if let Err(error) = run_before_destination_mutation_hook(path, &tmp_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    let mut expected_extra_entries = Vec::new();
    if !bundle.history.is_empty() {
        expected_extra_entries.push(".history.json");
    }
    if bundle.manifest.snapshot_files.is_empty() && !bundle.snapshots.is_empty() {
        expected_extra_entries.push(".snapshots.json");
    }

    if let Err(error) = validate_archive_manifest_and_entries(
        Path::new(&tmp_path),
        &bundle.manifest,
        &expected_extra_entries,
    ) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    if std::path::Path::new(path).exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn indexed_payload_with_manifest_name(
    value: &Value,
    id: &str,
    name: &str,
    kind: &str,
) -> Result<Value, AppError> {
    let mut object = value.as_object().cloned().ok_or_else(|| {
        AppError::FileIO(format!(
            "{kind} payload for manifest reference {id} must be a JSON object"
        ))
    })?;
    object.insert("name".to_string(), Value::String(name.to_string()));
    Ok(Value::Object(object))
}

fn write_zip_entry<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    data: &[u8],
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    zip.write_all(data)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

fn write_zip_json_entry<W: Write + Seek, T: Serialize>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &T,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    serde_json::to_writer(&mut *zip, value).map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

fn write_zip_json_entry_pretty<W: Write + Seek, T: Serialize>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &T,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    serde_json::to_writer_pretty(&mut *zip, value).map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

// ----------------------------------------------------------------------------
// Single-file table / graph IO (for share / re-import workflows)
// ----------------------------------------------------------------------------

/// Write a single `TableDoc` to a `.sptb` file (just JSON on disk for now).
pub fn write_table_file(doc: &TableDoc, path: &str) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Read a `.sptb` file from disk into a `TableDoc`.
pub fn read_table_file(path: &str) -> Result<TableDoc, AppError> {
    let bytes = std::fs::read(path)?;
    let doc: TableDoc = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid .sptb file: {}", e)))?;
    Ok(doc)
}

/// Write a single `GraphDoc` to a `.spgh` file.
pub fn write_graph_file(doc: &GraphDoc, path: &str) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Read a `.spgh` file from disk into a `GraphDoc`.
pub fn read_graph_file(path: &str) -> Result<GraphDoc, AppError> {
    let bytes = std::fs::read(path)?;
    parse_graph_doc(&bytes, "").map_err(|e| AppError::FileIO(format!("Invalid .spgh file: {}", e)))
}

/// Tolerant `.spgh` parser. Reads the bytes into a generic `serde_json::Value`
/// first so legacy files written before this fix — which carry a duplicate
/// top-level `id` key (one from the named struct field, one re-emitted by the
/// flattened `body`) — still load. `serde_json::Map` keeps only the last value
/// for duplicate keys, so the resulting map has a single `id` entry. We then
/// lift `id`, `name`, and `version` into the named struct fields so `body` no
/// longer carries them. Any in-body `folder` field from pre-#7 files is
/// silently discarded — the folder a graph lives in is now decided purely by
/// the archive path. `fallback_id` is used when the file omits `id` entirely.
fn parse_graph_doc(bytes: &[u8], fallback_id: &str) -> Result<GraphDoc, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut map = match value {
        Value::Object(m) => m,
        _ => return Err("graph file is not a JSON object".into()),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| {
            map.remove("builderId")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_else(|| fallback_id.to_string());
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let version = map
        .remove("version")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(default_doc_version);
    // Pre-#7 files may have stuffed a `folder` field inside the body —
    // strip it so it can never override the path-derived folder.
    map.remove("folder");
    Ok(GraphDoc {
        id,
        name,
        version,
        body: map,
    })
}

// ----------------------------------------------------------------------------
// Folder + name helpers
// ----------------------------------------------------------------------------

/// Characters disallowed inside a folder or file name segment. Matches the
/// strictest cross-platform filesystem rules so that extracted archives are
/// portable to any OS.
const FORBIDDEN_NAME_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_windows_reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default();
    WINDOWS_RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str())
}

pub(crate) fn validate_portable_basename(name: &str, subject: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{subject} cannot be empty"));
    }
    if name.starts_with(|c: char| c.is_whitespace() || c == '.')
        || name.ends_with(|c: char| c.is_whitespace() || c == '.')
    {
        return Err(format!(
            "{subject} has leading or trailing whitespace/dot: {}",
            name
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!("{subject} contains control character: {}", name));
    }
    if name.chars().any(|ch| FORBIDDEN_NAME_CHARS.contains(&ch)) {
        return Err(format!(
            "{subject} contains invalid filesystem characters: {}",
            name
        ));
    }
    if is_windows_reserved_stem(name) {
        return Err(format!(
            "{subject} is a reserved Windows device name: {}",
            name
        ));
    }
    Ok(())
}

pub(crate) fn normalize_unsafe_portable_basename(name: &str, fallback: &str) -> String {
    let sanitize = |source: &str| -> String {
        source
            .chars()
            .map(|ch| {
                if ch.is_control() || FORBIDDEN_NAME_CHARS.contains(&ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect::<String>()
            .trim_matches(|ch: char| ch.is_whitespace() || ch == '.')
            .to_string()
    };

    let mut candidate = sanitize(name);
    if candidate.is_empty() {
        candidate = sanitize(fallback);
    }
    if candidate.is_empty() {
        candidate = "untitled".to_string();
    }
    if is_windows_reserved_stem(&candidate) {
        candidate = format!("_{candidate}");
    }
    candidate
}

fn is_format_v4(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        == Some(4)
}

fn validate_display_basename(name: &str) -> Result<(), AppError> {
    validate_portable_basename(name, "Document name").map_err(AppError::FileIO)
}

fn allocate_archive_name(
    requested_name: &str,
    fallback_id: &str,
    extension: &str,
    root: &str,
    used_paths: &mut HashSet<String>,
) -> Result<(String, String), AppError> {
    let base = if requested_name.is_empty() {
        fallback_id.to_string()
    } else {
        requested_name.to_string()
    };
    validate_display_basename(&base)?;

    let mut suffix = 1usize;
    loop {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            format!("{}-{}", base, suffix)
        };
        let file = format!("{}/{}{}", root, candidate, extension);
        let key = file.to_ascii_lowercase();
        if !used_paths.contains(&key) {
            used_paths.insert(key);
            return Ok((candidate, file));
        }
        suffix = suffix.saturating_add(1);
    }
}

fn ensure_unique_manifest_id(
    seen: &mut HashSet<String>,
    id: &str,
    label: &str,
) -> Result<(), AppError> {
    let key = id.to_ascii_lowercase();
    if !seen.insert(key) {
        return Err(AppError::FileIO(format!(
            "Duplicate {label} stable id in manifest: {id}"
        )));
    }
    Ok(())
}

fn validate_manifest_stable_ids(manifest: &ProjectManifest) -> Result<(), AppError> {
    let mut table_ids = HashSet::new();
    for entry in &manifest.tables {
        ensure_unique_manifest_id(&mut table_ids, &entry.id, "table")?;
    }

    let mut graph_ids = HashSet::new();
    for entry in &manifest.graphs {
        ensure_unique_manifest_id(&mut graph_ids, &entry.id, "graph")?;
    }

    let mut report_ids = HashSet::new();
    for entry in &manifest.report_files {
        ensure_unique_manifest_id(&mut report_ids, &entry.id, "report")?;
    }

    let mut fit_ids = HashSet::new();
    let mut tabulate_ids = HashSet::new();
    let mut active_document_ids = HashSet::new();
    for entry in &manifest.fit_y_by_x_files {
        ensure_unique_manifest_id(&mut fit_ids, &entry.id, "fitYByX")?;
        ensure_unique_manifest_id(&mut active_document_ids, &entry.id, "active document")?;
    }
    for entry in &manifest.tabulate_files {
        ensure_unique_manifest_id(&mut tabulate_ids, &entry.id, "tabulate")?;
        ensure_unique_manifest_id(&mut active_document_ids, &entry.id, "active document")?;
    }

    let mut snapshot_ids = HashSet::new();
    for entry in &manifest.snapshot_files {
        ensure_unique_manifest_id(&mut snapshot_ids, &entry.id, "snapshot")?;
    }

    Ok(())
}

fn ensure_unique_bundle_id(
    seen: &mut HashSet<String>,
    id: &str,
    label: &str,
) -> Result<(), AppError> {
    let key = id.to_ascii_lowercase();
    if !seen.insert(key) {
        return Err(AppError::FileIO(format!(
            "Duplicate {label} stable id: {id}"
        )));
    }
    Ok(())
}

fn validate_bundle_payload_stable_ids(bundle: &ProjectBundle) -> Result<(), AppError> {
    let mut table_ids = HashSet::new();
    for doc in &bundle.tables {
        ensure_unique_bundle_id(&mut table_ids, &doc.id, "table")?;
    }

    let mut graph_ids = HashSet::new();
    for doc in &bundle.graphs {
        ensure_unique_bundle_id(&mut graph_ids, &doc.id, "graph")?;
    }

    let mut fit_ids = HashSet::new();
    let mut report_ids = HashSet::new();
    let mut tabulate_ids = HashSet::new();
    let mut active_document_ids = HashSet::new();
    for doc in &bundle.fit_y_by_x {
        let id = value_required_id(doc, "fitYByX")?;
        ensure_unique_bundle_id(&mut fit_ids, &id, "fitYByX")?;
        ensure_unique_bundle_id(&mut active_document_ids, &id, "active document")?;
    }
    for doc in &bundle.reports {
        let id = value_required_id(doc, "report")?;
        ensure_unique_bundle_id(&mut report_ids, &id, "report")?;
    }
    for doc in &bundle.tabulates {
        let id = value_required_id(doc, "tabulate")?;
        ensure_unique_bundle_id(&mut tabulate_ids, &id, "tabulate")?;
        ensure_unique_bundle_id(&mut active_document_ids, &id, "active document")?;
    }

    let mut snapshot_ids = HashSet::new();
    for doc in &bundle.snapshots {
        let id = value_required_id(doc, "snapshot")?;
        ensure_unique_bundle_id(&mut snapshot_ids, &id, "snapshot")?;
    }

    Ok(())
}

fn validate_bundle_before_write(bundle: &ProjectBundle) -> Result<(), AppError> {
    validate_bundle_payload_stable_ids(bundle)?;
    validate_manifest_entry_refs(&bundle.manifest)?;
    Ok(())
}

fn validate_manifest_entry_refs(manifest: &ProjectManifest) -> Result<(), AppError> {
    let mut seen_files = HashSet::new();
    let strict_v4_name_checks = is_format_v4(&manifest.version);

    if strict_v4_name_checks {
        validate_manifest_stable_ids(manifest)?;
        for entry in &manifest.tables {
            validate_indexed_path(&entry.file, "data", ".sptb", "table")?;
            validate_display_basename(&entry.name)?;
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                ".sptb",
                "table",
            )?;
            ensure_unique_file(&mut seen_files, &entry.file)?;
        }
        for entry in &manifest.graphs {
            validate_indexed_path(&entry.file, "data", ".spgh", "graph")?;
            validate_display_basename(&entry.name)?;
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                ".spgh",
                "graph",
            )?;
            ensure_unique_file(&mut seen_files, &entry.file)?;
        }
    }

    for entry in &manifest.report_files {
        if entry.kind != DocumentKind::Report {
            return Err(AppError::FileIO(format!(
                "report file entry has unexpected kind for {}",
                entry.file
            )));
        }
        validate_indexed_path(&entry.file, "data", ".sprp", "report")?;
        validate_display_basename(&entry.name)?;
        if strict_v4_name_checks {
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                ".sprp",
                "report",
            )?;
        }
        ensure_unique_file(&mut seen_files, &entry.file)?;
    }

    for entry in &manifest.fit_y_by_x_files {
        if entry.kind != DocumentKind::FitYByX {
            return Err(AppError::FileIO(format!(
                "fitYByX file entry has unexpected kind for {}",
                entry.file
            )));
        }
        validate_indexed_path(&entry.file, "data", ".spf", "fitYByX")?;
        validate_display_basename(&entry.name)?;
        if strict_v4_name_checks {
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                ".spf",
                "fitYByX",
            )?;
        }
        ensure_unique_file(&mut seen_files, &entry.file)?;
    }

    for entry in &manifest.tabulate_files {
        if entry.kind != DocumentKind::Tabulate {
            return Err(AppError::FileIO(format!(
                "tabulate file entry has unexpected kind for {}",
                entry.file
            )));
        }
        validate_indexed_path(&entry.file, "data", ".spf", "tabulate")?;
        validate_display_basename(&entry.name)?;
        if strict_v4_name_checks {
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                ".spf",
                "tabulate",
            )?;
        }
        ensure_unique_file(&mut seen_files, &entry.file)?;
    }

    for entry in &manifest.snapshot_files {
        let extension = if entry.file.to_ascii_lowercase().ends_with(".json") {
            ".json"
        } else {
            ".spf"
        };
        validate_indexed_path(&entry.file, "snapshots", extension, "snapshot")?;
        validate_display_basename(&entry.name)?;
        if strict_v4_name_checks {
            validate_manifest_name_matches_file_basename(
                &entry.file,
                &entry.name,
                extension,
                "snapshot",
            )?;
        }
        ensure_unique_file(&mut seen_files, &entry.file)?;
    }

    Ok(())
}

fn ensure_unique_file(seen: &mut HashSet<String>, file: &str) -> Result<(), AppError> {
    let key = file.to_ascii_lowercase();
    if seen.contains(&key) {
        return Err(AppError::FileIO(format!(
            "Duplicate archive entry path in manifest: {}",
            file
        )));
    }
    seen.insert(key);
    Ok(())
}

fn validate_indexed_path(
    file: &str,
    root: &str,
    extension: &str,
    label: &str,
) -> Result<(), AppError> {
    if file.is_empty() || file.starts_with('/') || file.contains('\\') {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive path: {}",
            file
        )));
    }
    if file.contains("//") {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive path: {}",
            file
        )));
    }

    let prefix = format!("{root}/");
    if !file.starts_with(&prefix) {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive root: {}",
            file
        )));
    }
    let leaf = &file[prefix.len()..];
    if leaf.is_empty() || leaf.contains('/') {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive path (must be flat under {root}/): {}",
            file
        )));
    }
    if !leaf.ends_with(extension) {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive extension in {}",
            file
        )));
    }
    if leaf == "." || leaf == ".." || leaf.contains("../") || leaf.contains("./") {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive path traversal: {}",
            file
        )));
    }

    let basename = &leaf[..leaf.len() - extension.len()];
    validate_display_basename(basename)
}

fn validate_manifest_name_matches_file_basename(
    file: &str,
    manifest_name: &str,
    extension: &str,
    label: &str,
) -> Result<(), AppError> {
    let leaf = file
        .rsplit('/')
        .next()
        .ok_or_else(|| AppError::FileIO(format!("Invalid {label} archive path: {}", file)))?;
    if !leaf.ends_with(extension) || leaf.len() <= extension.len() {
        return Err(AppError::FileIO(format!(
            "Invalid {label} archive extension in {}",
            file
        )));
    }
    let basename = &leaf[..leaf.len() - extension.len()];
    if basename != manifest_name {
        return Err(AppError::FileIO(format!(
            "Mismatched {label} name and archive basename in {}: manifest={}, basename={}",
            file, manifest_name, basename
        )));
    }
    Ok(())
}

fn value_required_id(value: &Value, kind: &str) -> Result<String, AppError> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::FileIO(format!("{kind} document is missing required id")))
}

fn value_name_or_fallback(value: &Value, fallback_id: &str) -> String {
    value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_id.to_string())
}

fn value_required_name<'a>(value: &'a Value, file: &str, kind: &str) -> Result<&'a str, AppError> {
    value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            AppError::FileIO(format!(
                "Indexed {kind} file {} missing required name",
                file
            ))
        })
}

fn validate_report_value(value: &Value, context: &str) -> Result<(), AppError> {
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            AppError::FileIO(format!(
                "{context} report is missing required schemaVersion"
            ))
        })?;
    if schema_version != 1 {
        return Err(AppError::FileIO(format!(
            "{context} report must use schemaVersion 1"
        )));
    }
    value_required_id(value, "report")?;
    value_required_name(value, context, "report")?;
    match value.get("markdown").and_then(Value::as_str) {
        Some(_) => Ok(()),
        None => Err(AppError::FileIO(format!(
            "{context} report is missing required markdown"
        ))),
    }
}

fn set_value_name(value: &mut Value, name: &str, kind: &str) -> Result<(), AppError> {
    let Some(map) = value.as_object_mut() else {
        return Err(AppError::FileIO(format!(
            "{kind} document body is not a JSON object"
        )));
    };
    map.insert("name".to_string(), Value::String(name.to_string()));
    Ok(())
}

/// Sanitize a user-visible name for use as an archive filename component.
/// Replaces forbidden chars with `_`, trims leading/trailing whitespace and
/// dots, and falls back to `fallback` (typically the entry id) if the result
/// is empty.
pub fn sanitize_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if FORBIDDEN_NAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalize a folder path. Returns `None` for root (empty / `None` / `"/"`).
/// Splits on `/` and `\`, sanitizes each segment, and rejoins with `/`.
pub fn normalize_folder(folder: Option<&str>) -> Option<String> {
    let raw = folder?.trim();
    if raw.is_empty() {
        return None;
    }
    let segs: Vec<String> = raw
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty())
        .map(|s| sanitize_name(s, "_"))
        .collect();
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    }
}

/// Normalize a list of folder paths and add implicit ancestors so the writer
/// can emit a complete directory tree on extraction.
fn normalize_folder_list(folders: Vec<String>) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    for f in folders {
        if let Some(norm) = normalize_folder(Some(&f)) {
            for anc in folder_ancestors(&norm) {
                out.insert(anc);
            }
        }
    }
    let mut sorted: Vec<String> = out.into_iter().collect();
    sorted.sort();
    sorted
}

/// Parent folder of an archive entry path, or `None` if at root.
pub fn parent_folder(file: &str) -> Option<String> {
    let idx = file.rfind('/')?;
    Some(file[..idx].to_string())
}

/// All ancestor folder paths of `folder`, including `folder` itself, in
/// shallow-to-deep order (e.g. `["a", "a/b", "a/b/c"]`). Returns empty vec
/// when the input is empty.
fn folder_ancestors(folder: &str) -> Vec<String> {
    let parts: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::with_capacity(parts.len());
    for i in 1..=parts.len() {
        out.push(parts[..i].join("/"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

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

    fn fit_doc(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "sourceDatasetId": "table-1",
            "response": { "name": "y", "type": "continuous" },
            "factor": { "name": "x", "type": "continuous" }
        })
    }

    fn tabulate_doc(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "sourceDatasetId": "table-1",
            "rowFields": [],
            "columnFields": [],
            "statistics": []
        })
    }

    fn snapshot_doc(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "createdAt": "2026-09-01T00:00:00Z",
            "request": {
                "name": "snap-request",
                "datasets": [],
                "graphBuilders": [],
                "fitYByX": [],
                "reports": [],
                "tabulates": [],
                "history": [],
                "folders": [],
                "tableFolders": {},
                "graphFolders": {},
                "fitYByXFolders": {},
                "reportFolders": {},
                "tabulateFolders": {}
            }
        })
    }

    fn report_doc(id: &str, name: &str, markdown: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "id": id,
            "name": name,
            "markdown": markdown,
        })
    }

    #[test]
    fn build_bundle_allocates_v4_flat_named_paths_and_indexes_docs() {
        let table = table_doc("table-id", "data");
        let graph = graph_doc("graph-id", "data");
        let fit = fit_doc("fit-1", "data");
        let tabulate = tabulate_doc("tab-1", "data");
        let snapshot = snapshot_doc("snap-1", "data");
        let table_folders = HashMap::from([(String::from("table-id"), String::from("Raw/2026"))]);
        let graph_folders = HashMap::from([(String::from("graph-id"), String::from("Reports"))]);
        let fit_folders = HashMap::from([(String::from("fit-1"), String::from("Analyses/Fit"))]);
        let tabulate_folders =
            HashMap::from([(String::from("tab-1"), String::from("Analyses/Tabulate"))]);

        let bundle = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table],
            vec![graph],
            vec![fit],
            vec![],
            vec![tabulate],
            vec!["Raw/2026".into(), "Reports".into(), "Analyses/Fit".into()],
            &table_folders,
            &graph_folders,
            &fit_folders,
            &HashMap::new(),
            &tabulate_folders,
            vec![],
            vec![snapshot],
        )
        .unwrap();

        assert_eq!(bundle.manifest.tables[0].file, "data/data.sptb");
        assert_eq!(bundle.manifest.graphs[0].file, "data/data.spgh");
        assert_eq!(bundle.manifest.fit_y_by_x_files[0].file, "data/data.spf");
        assert_eq!(bundle.manifest.tabulate_files[0].file, "data/data-2.spf");
        assert_eq!(
            bundle.manifest.snapshot_files[0].file,
            "snapshots/data.json"
        );
        assert_eq!(bundle.manifest.table_folders.as_ref(), Some(&table_folders));
        assert_eq!(bundle.manifest.graph_folders.as_ref(), Some(&graph_folders));

        let manifest_json = serde_json::to_value(&bundle.manifest).expect("serialize manifest");
        assert!(manifest_json.get("fitYByX").is_none());
        assert!(manifest_json.get("tabulates").is_none());

        for entry in bundle
            .manifest
            .tables
            .iter()
            .map(|entry| entry.file.as_str())
            .chain(
                bundle
                    .manifest
                    .graphs
                    .iter()
                    .map(|entry| entry.file.as_str()),
            )
            .chain(
                bundle
                    .manifest
                    .fit_y_by_x_files
                    .iter()
                    .map(|entry| entry.file.as_str()),
            )
            .chain(
                bundle
                    .manifest
                    .tabulate_files
                    .iter()
                    .map(|entry| entry.file.as_str()),
            )
            .chain(
                bundle
                    .manifest
                    .snapshot_files
                    .iter()
                    .map(|entry| entry.file.as_str()),
            )
        {
            assert!(!entry.contains("/Raw/"));
            assert!(!entry.contains("/Reports/"));
            assert!(!entry.contains("/Analyses/"));
        }
    }

    #[test]
    fn build_bundle_suffixes_case_insensitive_name_collisions_within_extension_namespace() {
        let bundle = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "Data"), table_doc("table-2", "data")],
            vec![graph_doc("graph-1", "DATA"), graph_doc("graph-2", "data")],
            vec![fit_doc("fit-1", "Data"), fit_doc("fit-2", "data")],
            vec![],
            vec![tabulate_doc("tab-1", "DATA")],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        assert_eq!(bundle.manifest.tables[0].file, "data/Data.sptb");
        assert_eq!(bundle.manifest.tables[1].file, "data/data-2.sptb");
        assert_eq!(bundle.manifest.graphs[0].file, "data/DATA.spgh");
        assert_eq!(bundle.manifest.graphs[1].file, "data/data-2.spgh");
        assert_eq!(bundle.manifest.fit_y_by_x_files[0].file, "data/Data.spf");
        assert_eq!(bundle.manifest.fit_y_by_x_files[1].file, "data/data-2.spf");
        assert_eq!(bundle.manifest.tabulate_files[0].file, "data/DATA-3.spf");
    }

    #[test]
    fn build_bundle_rejects_windows_reserved_and_control_character_names() {
        let reserved = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "CON")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(matches!(reserved, Err(AppError::FileIO(message)) if message.contains("reserved")));

        let reserved_with_extension = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "CON.txt")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(reserved_with_extension, Err(AppError::FileIO(message)) if message.contains("reserved"))
        );

        let reserved_lpt_with_extension = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "LPT9.log")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(reserved_lpt_with_extension, Err(AppError::FileIO(message)) if message.contains("reserved"))
        );

        let control = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "bad\u{0007}name")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(control, Err(AppError::FileIO(message)) if message.contains("control character"))
        );
    }

    #[test]
    fn build_bundle_rejects_missing_doc_id() {
        let missing_id = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![json!({"name": "fit"})],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(missing_id, Err(AppError::FileIO(message)) if message.contains("fitYByX document is missing required id"))
        );
    }

    #[test]
    fn manifest_round_trip_preserves_empty_folder_maps() {
        let manifest = ProjectManifest {
            name: "Project".into(),
            version: "3.0.0".into(),
            created_at: "now".into(),
            tables: vec![],
            graphs: vec![],
            folders: vec![],
            table_folders: Some(HashMap::new()),
            graph_folders: Some(HashMap::new()),
            fit_y_by_x: vec![],
            fit_y_by_x_folders: HashMap::new(),
            report_folders: HashMap::new(),
            tabulates: vec![],
            tabulate_folders: HashMap::new(),
            report_files: vec![],
            fit_y_by_x_files: vec![],
            tabulate_files: vec![],
            snapshot_files: vec![],
        };

        let json = serde_json::to_vec(&manifest).expect("serialize manifest");
        let round_trip: ProjectManifest =
            serde_json::from_slice(&json).expect("deserialize manifest");

        assert_eq!(round_trip.table_folders, Some(HashMap::new()));
        assert_eq!(round_trip.graph_folders, Some(HashMap::new()));
        assert!(round_trip.fit_y_by_x.is_empty());
        assert!(round_trip.fit_y_by_x_folders.is_empty());
    }

    #[test]
    fn report_round_trip_preserves_markdown_and_folder_map() {
        let path = temp_project_path("report-round-trip");
        let report = report_doc("report-1", "Report 1", "# Hello report");
        let report_folders = HashMap::from([(String::from("report-1"), String::from("Reports"))]);

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![report.clone()],
            Vec::new(),
            vec!["Reports".to_string()],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &report_folders,
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.report_files.len(), 1);
        assert_eq!(loaded.manifest.report_files[0].file, "data/Report 1.sprp");
        assert_eq!(loaded.manifest.report_files[0].kind, DocumentKind::Report);
        assert_eq!(loaded.manifest.report_folders, report_folders);
        assert_eq!(loaded.reports, vec![report]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn report_missing_manifest_fields_default_cleanly() {
        let path = temp_project_path("report-defaults");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({
            "name": "Compat Project",
            "version": "2.0.0",
            "createdAt": "2026-08-14T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": [],
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(&manifest_bytes).unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(loaded.manifest.report_files.is_empty());
        assert!(loaded.manifest.report_folders.is_empty());
        assert!(loaded.reports.is_empty());

        let _ = std::fs::remove_file(path);
    }

    use serde_json::json;

    fn temp_project_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "statsplayground-spprj-{}-{}.spprj",
            name,
            uuid::Uuid::new_v4()
        ))
    }

    fn rewrite_named_entry_in_archive(
        source_path: &std::path::Path,
        destination_path: &std::path::Path,
        target_entry: &str,
        replacement_bytes: &[u8],
    ) -> Result<(), AppError> {
        let input = std::fs::File::open(source_path)?;
        let mut input_zip = zip::ZipArchive::new(input)
            .map_err(|e| AppError::FileIO(format!("failed to open archive for mutation: {e}")))?;
        let output = std::fs::File::create(destination_path)?;
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip
                .by_index(index)
                .map_err(|e| AppError::FileIO(format!("failed to read archive entry: {e}")))?;
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| AppError::FileIO(format!("failed to copy archive entry: {e}")))?;
            output_zip
                .start_file(entry.name(), opts)
                .map_err(|e| AppError::FileIO(format!("failed to create archive entry: {e}")))?;
            if entry.name() == target_entry {
                output_zip.write_all(replacement_bytes).map_err(|e| {
                    AppError::FileIO(format!("failed to write replacement archive entry: {e}"))
                })?;
            } else {
                output_zip
                    .write_all(&bytes)
                    .map_err(|e| AppError::FileIO(format!("failed to write archive entry: {e}")))?;
            }
        }

        output_zip
            .finish()
            .map_err(|e| AppError::FileIO(format!("failed to finish mutated archive: {e}")))?;
        Ok(())
    }

    #[test]
    fn build_bundle_rejects_duplicate_stable_ids_in_domains_and_active_namespace() {
        let duplicate_table = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![table_doc("table-1", "a"), table_doc("table-1", "b")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_table, Err(AppError::FileIO(message)) if message.contains("Duplicate table stable id"))
        );

        let duplicate_graph = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![graph_doc("graph-1", "a"), graph_doc("graph-1", "b")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_graph, Err(AppError::FileIO(message)) if message.contains("Duplicate graph stable id"))
        );

        let duplicate_fit = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![fit_doc("fit-1", "a"), fit_doc("fit-1", "b")],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_fit, Err(AppError::FileIO(message)) if message.contains("Duplicate fitYByX stable id"))
        );

        let duplicate_report = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![],
            vec![
                report_doc("report-1", "a", "# a"),
                report_doc("report-1", "b", "# b"),
            ],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_report, Err(AppError::FileIO(message)) if message.contains("Duplicate report stable id"))
        );

        let duplicate_tabulate = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![],
            vec![],
            vec![tabulate_doc("tab-1", "a"), tabulate_doc("tab-1", "b")],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_tabulate, Err(AppError::FileIO(message)) if message.contains("Duplicate tabulate stable id"))
        );

        let duplicate_snapshot = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![snapshot_doc("snap-1", "a"), snapshot_doc("snap-1", "b")],
        );
        assert!(
            matches!(duplicate_snapshot, Err(AppError::FileIO(message)) if message.contains("Duplicate snapshot stable id"))
        );

        let duplicate_active_namespace = build_bundle(
            "Project".into(),
            "4.0.0".into(),
            "now".into(),
            vec![],
            vec![],
            vec![fit_doc("shared-id", "fit")],
            vec![],
            vec![tabulate_doc("shared-id", "tab")],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );
        assert!(
            matches!(duplicate_active_namespace, Err(AppError::FileIO(message)) if message.contains("Duplicate active document stable id"))
        );
    }

    #[test]
    fn tabulate_round_trip_preserves_opaque_json_and_folder_map() {
        let path = temp_project_path("tabulate-round-trip");
        let tabulate = json!({
            "id": "tab-1",
            "name": "Tabulate 1",
            "sourceDatasetId": "table-1",
            "rowFields": ["Region"],
            "columnFields": [],
            "statistics": [],
        });
        let folders = HashMap::from([("tab-1".to_string(), "Reports".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![tabulate.clone()],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.tabulates, vec![tabulate.clone()]);
        assert_eq!(loaded.manifest.tabulate_folders, folders);
        assert_eq!(loaded.tabulates, vec![tabulate]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_round_trip_preserves_opaque_json_and_folder_map() {
        let path = temp_project_path("fit-y-by-x-round-trip");
        let fit = json!({
            "id": "fit-1",
            "sourceDatasetId": "table-1",
            "response": { "name": "height", "type": "continuous" },
            "factor": { "name": "site", "type": "nominal" }
        });
        let mut expected_fit = fit.clone();
        expected_fit
            .as_object_mut()
            .expect("fit should be an object")
            .insert("name".to_string(), Value::String("fit-1".to_string()));
        let folders = HashMap::from([("fit-1".to_string(), "Analyses".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            vec![fit.clone()],
            Vec::new(),
            Vec::new(),
            vec!["Analyses".to_string()],
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            &HashMap::new(),
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.fit_y_by_x, vec![expected_fit.clone()]);
        assert_eq!(loaded.manifest.fit_y_by_x_folders, folders);
        assert_eq!(loaded.fit_y_by_x, vec![expected_fit]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_archive_preserves_definition_fields_without_computed_results() {
        let path = temp_project_path("fit-y-by-x-definition-only");
        let fit = json!({
            "id": "fit-1",
            "name": "Fit Y by X 2",
            "sourceDatasetId": "table-1",
            "response": { "name": "height", "type": "continuous" },
            "factor": { "name": "age", "type": "continuous" },
            "personality": "bivariate",
            "graph": {
                "mode": "2d",
                "modeStates": {
                    "twoD": {
                        "encoding": {
                            "x": { "name": "age", "type": "continuous" },
                            "y": { "name": "height", "type": "continuous" }
                        },
                        "multiX": [],
                        "multiY": [],
                        "elements": [
                            { "kind": "points", "enabled": true },
                            {
                                "kind": "fitline",
                                "enabled": true,
                                "options": { "fitType": "polynomial", "degree": 1, "showFitCI": true }
                            }
                        ],
                        "smootherLambda": 0.4
                    },
                    "threeD": {
                        "encoding": {},
                        "elements": [{ "kind": "scatter3d", "enabled": true }],
                        "smootherLambda": 0.4
                    },
                    "multivariate": {
                        "columns": [],
                        "chartType": "correlationMatrix",
                        "correlationMethod": "pearson"
                    }
                },
                "filters": [],
                "sampling": { "mode": "full" }
            },
            "result": {
                "kind": "bivariate",
                "usedRows": 42,
                "excludedRows": 3,
                "summaryOfFit": {
                    "rsquare": 0.91,
                    "rsquareAdj": 0.9,
                    "rootMeanSquareError": 1.25,
                    "meanOfResponse": 18.4,
                    "observations": 42
                },
                "parameterEstimates": [
                    {
                        "term": "Intercept",
                        "estimate": 1.5,
                        "stdError": 0.2,
                        "tRatio": 7.5,
                        "probGtAbsT": 0.001
                    },
                    {
                        "term": "age",
                        "estimate": 0.8,
                        "stdError": 0.1,
                        "tRatio": 8.0,
                        "probGtAbsT": 0.001
                    }
                ]
            },
            "reportState": {
                "selectedTab": "report",
                "expandedSections": ["summaryOfFit", "parameterEstimates"]
            },
            "createdAt": "2026-08-31T00:00:00.000Z"
        });
        let mut expected_fit = fit.clone();
        expected_fit
            .as_object_mut()
            .expect("fit should be an object")
            .remove("result");
        expected_fit
            .as_object_mut()
            .expect("fit should be an object")
            .remove("reportState");
        let folders = HashMap::from([("fit-1".to_string(), "Analyses/Bivariate".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "2.0.0".to_string(),
            "2026-08-31T00:00:00.000Z".to_string(),
            Vec::new(),
            Vec::new(),
            vec![fit.clone()],
            Vec::new(),
            Vec::new(),
            vec!["Analyses".to_string(), "Analyses/Bivariate".to_string()],
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            &HashMap::new(),
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let archive = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        let mut manifest_entry = zip.by_name("manifest.json").unwrap();
        let mut manifest_bytes = Vec::new();
        manifest_entry.read_to_end(&mut manifest_bytes).unwrap();
        let manifest_json: Value = serde_json::from_slice(&manifest_bytes).unwrap();

        let persisted_fit = manifest_json
            .get("fitYByX")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_object)
            .unwrap();

        assert_eq!(persisted_fit.get("name"), fit.get("name"));
        assert_eq!(persisted_fit.get("response"), fit.get("response"));
        assert_eq!(persisted_fit.get("factor"), fit.get("factor"));
        assert_eq!(persisted_fit.get("personality"), fit.get("personality"));
        assert_eq!(persisted_fit.get("graph"), fit.get("graph"));
        assert_eq!(persisted_fit.get("createdAt"), fit.get("createdAt"));
        assert!(!persisted_fit.contains_key("result"));
        assert!(!persisted_fit.contains_key("reportState"));

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.manifest.fit_y_by_x, vec![expected_fit.clone()]);
        assert_eq!(loaded.fit_y_by_x, vec![expected_fit]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tabulate_missing_manifest_fields_default_cleanly() {
        let path = temp_project_path("tabulate-defaults");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({
            "name": "Compat Project",
            "version": "2.0.0",
            "createdAt": "2026-08-14T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": [],
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(&manifest_bytes).unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(loaded.manifest.tabulates.is_empty());
        assert!(loaded.manifest.tabulate_folders.is_empty());
        assert!(loaded.tabulates.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fit_y_by_x_missing_manifest_fields_default_cleanly() {
        let path = temp_project_path("fit-y-by-x-defaults");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({
            "name": "Compat Project",
            "version": "2.0.0",
            "createdAt": "2026-08-14T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": [],
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(&manifest_bytes).unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(loaded.manifest.fit_y_by_x.is_empty());
        assert!(loaded.manifest.fit_y_by_x_folders.is_empty());
        assert!(loaded.fit_y_by_x.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_archive_accepts_table_entry_without_deep_table_body_validation() {
        let path = temp_project_path("validate-table-open-only");

        let mut table = table_doc("table-1", "Table 1");
        table.rows = (0_i64..40_000_i64)
            .map(|row| vec![json!(row), json!(row * 2), json!(format!("row-{row}"))])
            .collect();
        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen_clone = std::sync::Arc::clone(&seen);
        install_test_validate_table_entry_open_hook(Some(Box::new(
            move |entry_name, entry_size, body_bytes_read| {
                if entry_name.ends_with(".sptb") {
                    seen_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                    assert!(entry_size > 1_000_000);
                    assert_eq!(body_bytes_read, 0);
                }
                Ok(())
            },
        )));

        validate_archive_manifest_and_entries(&path, &bundle.manifest, &[]).unwrap();
        install_test_validate_table_entry_open_hook(None);

        assert!(seen.load(std::sync::atomic::Ordering::SeqCst));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_archive_rejects_missing_expected_table_entry() {
        let path = temp_project_path("validate-missing-entry");
        let missing_path = temp_project_path("validate-missing-entry-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&missing_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            if entry.name().ends_with(".sptb") {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            output_zip.write_all(&bytes).unwrap();
        }
        output_zip.finish().unwrap();

        let error = validate_archive_manifest_and_entries(&missing_path, &bundle.manifest, &[])
            .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("missing table entry"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(missing_path);
    }

    #[test]
    fn validate_archive_rejects_missing_expected_fit_entry() {
        let path = temp_project_path("validate-missing-fit-entry");
        let missing_path = temp_project_path("validate-missing-fit-entry-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![fit_doc("fit-1", "Fit 1")],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&missing_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            if entry.name() == "data/Fit 1.spf" {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            output_zip.write_all(&bytes).unwrap();
        }
        output_zip.finish().unwrap();

        let error = validate_archive_manifest_and_entries(&missing_path, &bundle.manifest, &[])
            .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("missing fit entry"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(missing_path);
    }

    #[test]
    fn validate_archive_rejects_truncated_archive_file() {
        let path = temp_project_path("validate-truncated-archive");
        let truncated_path = temp_project_path("validate-truncated-archive-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let mut bytes = std::fs::read(&path).unwrap();
        bytes.truncate(bytes.len().saturating_sub(24));
        std::fs::write(&truncated_path, &bytes).unwrap();

        let error = validate_archive_manifest_and_entries(&truncated_path, &bundle.manifest, &[])
            .unwrap_err();
        assert!(matches!(error, AppError::FileIO(_)));

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(truncated_path);
    }

    #[test]
    fn validate_archive_rejects_missing_manifest() {
        let path = temp_project_path("validate-missing-manifest");
        let missing_manifest_path = temp_project_path("validate-missing-manifest-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();
        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&missing_manifest_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            if entry.name() == "manifest.json" {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            output_zip.write_all(&bytes).unwrap();
        }
        output_zip.finish().unwrap();

        let error =
            validate_archive_manifest_and_entries(&missing_manifest_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("missing manifest.json"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(missing_manifest_path);
    }

    #[test]
    fn validate_archive_rejects_invalid_manifest_json() {
        let path = temp_project_path("validate-bad-manifest");
        let bad_manifest_path = temp_project_path("validate-bad-manifest-out");

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-14T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![graph_doc("graph-1", "Graph 1")],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let input = std::fs::File::open(&path).unwrap();
        let mut input_zip = zip::ZipArchive::new(input).unwrap();
        let output = std::fs::File::create(&bad_manifest_path).unwrap();
        let mut output_zip = zip::ZipWriter::new(output);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for index in 0..input_zip.len() {
            let mut entry = input_zip.by_index(index).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            output_zip.start_file(entry.name(), opts).unwrap();
            if entry.name() == "manifest.json" {
                output_zip.write_all(br#"{"name":"broken""#).unwrap();
            } else {
                output_zip.write_all(&bytes).unwrap();
            }
        }
        output_zip.finish().unwrap();

        let error =
            validate_archive_manifest_and_entries(&bad_manifest_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Invalid manifest.json"))
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(bad_manifest_path);
    }

    #[test]
    fn write_project_archive_v4_matches_flat_streaming_contract_without_logical_folders() {
        let path = temp_project_path("write-v4-flat");
        let table = table_doc("table-1", "data");
        let graph = graph_doc("graph-1", "data");
        let fit = fit_doc("fit-1", "data");
        let report = report_doc("report-1", "Report 1", "# report body");
        let tabulate = tabulate_doc("tab-1", "data");
        let snapshot = snapshot_doc("snap-1", "data");
        let report_folders = HashMap::from([("report-1".to_string(), "Root/Nested".to_string())]);
        let tabulate_folders = HashMap::from([("tab-1".to_string(), "Root".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table],
            vec![graph],
            vec![fit],
            vec![report],
            vec![tabulate],
            vec![
                "Root".to_string(),
                "Root/Nested".to_string(),
                "Root/Nested/Leaf".to_string(),
            ],
            &HashMap::from([("table-1".to_string(), "Root/Nested".to_string())]),
            &HashMap::from([("graph-1".to_string(), "Root/Nested/Leaf".to_string())]),
            &HashMap::from([("fit-1".to_string(), "Root/Nested/Leaf".to_string())]),
            &report_folders,
            &tabulate_folders,
            vec![json!({"event": "save"})],
            vec![snapshot],
        )
        .unwrap();

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut entries = HashSet::new();
        for index in 0..zip.len() {
            let entry = zip.by_index(index).unwrap();
            entries.insert(entry.name().to_string());
        }

        let expected = HashSet::from([
            "manifest.json".to_string(),
            "data/data.sptb".to_string(),
            "data/data.spgh".to_string(),
            "data/data.spf".to_string(),
            "data/Report 1.sprp".to_string(),
            "data/data-2.spf".to_string(),
            "snapshots/data.json".to_string(),
            ".history.json".to_string(),
        ]);
        assert_eq!(entries, expected);
        assert!(!entries.contains(".snapshots.json"));
        assert!(!entries.contains("data/report-1.sprp"));
        assert!(entries.iter().all(|entry| !entry.starts_with("tables/")));
        assert!(entries.iter().all(|entry| !entry.starts_with("graphs/")));
        assert!(entries.iter().all(|entry| !entry.contains("Root/")));
        assert!(entries.iter().all(|entry| !entry.ends_with('/')));

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.manifest.report_folders, report_folders);
        assert_eq!(loaded.manifest.tabulate_folders, tabulate_folders);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_v4_rejects_missing_indexed_payload_and_preserves_destination() {
        let path = temp_project_path("write-v4-missing-fit-payload");
        std::fs::write(&path, b"original-bytes").unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let mut bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "data")],
            vec![graph_doc("graph-1", "data")],
            vec![fit_doc("fit-1", "data")],
            Vec::new(),
            vec![tabulate_doc("tab-1", "data")],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        bundle.fit_y_by_x.clear();
        let error = write_project_archive(&bundle, path.to_str().unwrap()).unwrap_err();

        assert!(matches!(
            error,
            AppError::FileIO(message)
            if message.contains("missing fit payload for manifest reference fit-1")
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.to_string_lossy())).exists());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_validates_completed_temp_archive_before_replace() {
        let path = temp_project_path("write-v4-validation-before-replace");
        std::fs::write(&path, b"destination-before-save").unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "Table 1")],
            vec![],
            vec![],
            vec![],
            vec![],
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        install_test_before_destination_mutation_hook(Some(Box::new(move |_dest, tmp_path| {
            let mut bytes = std::fs::read(tmp_path)?;
            bytes.truncate(bytes.len().saturating_sub(24));
            std::fs::write(tmp_path, bytes)?;
            Ok(())
        })));

        let error = write_project_archive(&bundle, path.to_str().unwrap()).unwrap_err();
        install_test_before_destination_mutation_hook(None);

        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Invalid project archive during validation"))
        );
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.to_string_lossy())).exists());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_rejects_duplicate_manifest_stable_ids_before_writing_destination() {
        let path = temp_project_path("write-v4-duplicate-stable-id");
        std::fs::write(&path, b"destination-before-save").unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let mut bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "data")],
            vec![],
            vec![fit_doc("fit-1", "fit")],
            Vec::new(),
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        bundle
            .fit_y_by_x
            .push(json!({"id": "fit-1", "name": "fit-duplicate"}));
        bundle.manifest.fit_y_by_x_files.push(DocumentEntryRef {
            id: "fit-1".to_string(),
            name: "fit-duplicate".to_string(),
            file: "data/fit-duplicate.spf".to_string(),
            kind: DocumentKind::FitYByX,
        });

        let error = write_project_archive(&bundle, path.to_str().unwrap()).unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Duplicate fitYByX stable id"))
        );
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.to_string_lossy())).exists());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_rejects_duplicate_report_manifest_stable_ids_before_writing_destination(
    ) {
        let path = temp_project_path("write-v4-duplicate-report-stable-id");
        std::fs::write(&path, b"destination-before-save").unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let mut bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![],
            vec![],
            vec![],
            vec![report_doc("report-1", "Report 1", "# body")],
            vec![],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        )
        .unwrap();

        bundle.manifest.report_files.push(DocumentEntryRef {
            id: "report-1".to_string(),
            name: "Report 1 copy".to_string(),
            file: "data/Report 1 copy.sprp".to_string(),
            kind: DocumentKind::Report,
        });

        let error = write_project_archive(&bundle, path.to_str().unwrap()).unwrap_err();
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Duplicate report stable id in manifest"))
        );
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.to_string_lossy())).exists());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_body_parity_validation_failure_preserves_destination() {
        let path = temp_project_path("write-v4-body-parity-validation");
        std::fs::write(&path, b"destination-before-save").unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "data")],
            vec![graph_doc("graph-1", "graph-data")],
            vec![fit_doc("fit-1", "fit-data")],
            Vec::new(),
            vec![tabulate_doc("tab-1", "tab-data")],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![snapshot_doc("snap-1", "snap-data")],
        )
        .unwrap();

        install_test_before_destination_mutation_hook(Some(Box::new(move |_dest, tmp_path| {
            let source = std::path::Path::new(tmp_path).to_path_buf();
            let rewritten = std::path::PathBuf::from(format!("{}.mut", tmp_path));
            rewrite_named_entry_in_archive(
                &source,
                &rewritten,
                "data/graph-data.spgh",
                br#"{"id":"graph-1","name":"wrong-name","version":"1"}"#,
            )?;
            std::fs::remove_file(&source)?;
            std::fs::rename(&rewritten, &source)?;
            Ok(())
        })));

        let error = write_project_archive(&bundle, path.to_str().unwrap()).unwrap_err();
        install_test_before_destination_mutation_hook(None);

        assert!(matches!(error, AppError::FileIO(message) if message.contains("graph name")));
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.to_string_lossy())).exists());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_project_archive_v4_syncs_indexed_body_name_to_manifest_name() {
        let path = temp_project_path("write-v4-body-name-sync");
        let mut bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "data")],
            vec![graph_doc("graph-1", "data")],
            vec![fit_doc("fit-1", "data")],
            Vec::new(),
            vec![tabulate_doc("tab-1", "data")],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![snapshot_doc("snap-1", "data")],
        )
        .unwrap();

        bundle.fit_y_by_x[0]["name"] = Value::String("stale-fit-name".to_string());
        bundle.tabulates[0]["name"] = Value::String("stale-tab-name".to_string());
        bundle.snapshots[0]["name"] = Value::String("stale-snapshot-name".to_string());

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        for fit_ref in &bundle.manifest.fit_y_by_x_files {
            let mut entry = zip.by_name(&fit_ref.file).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                value.get("name").and_then(Value::as_str),
                Some(fit_ref.name.as_str())
            );
        }
        for tab_ref in &bundle.manifest.tabulate_files {
            let mut entry = zip.by_name(&tab_ref.file).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                value.get("name").and_then(Value::as_str),
                Some(tab_ref.name.as_str())
            );
        }
        for snap_ref in &bundle.manifest.snapshot_files {
            let mut entry = zip.by_name(&snap_ref.file).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                value.get("name").and_then(Value::as_str),
                Some(snap_ref.name.as_str())
            );
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_wrong_index_kind() {
        let path = temp_project_path("v4-wrong-kind");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [
                { "id": "fit-1", "name": "data", "file": "data/data.spf", "kind": "tabulate" }
            ],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected wrong-kind manifest read to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("unexpected kind")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_body_id_mismatch() {
        let path = temp_project_path("v4-body-id-mismatch");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [
                { "id": "fit-1", "name": "data", "file": "data/data.spf", "kind": "fitYByX" }
            ],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("data/data.spf", opts).unwrap();
        zip.write_all(br#"{"id":"fit-2","name":"data"}"#).unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected body-id mismatch manifest read to fail"),
            Err(error) => error,
        };
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Mismatched document id"))
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_duplicate_indexed_paths() {
        let path = temp_project_path("v4-duplicate-indexed-path");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [
                { "id": "fit-1", "name": "shared", "file": "data/shared.spf", "kind": "fitYByX" }
            ],
            "tabulateFiles": [
                { "id": "tab-1", "name": "SHARED", "file": "data/SHARED.spf", "kind": "tabulate" }
            ],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected duplicate-path manifest read to fail"),
            Err(error) => error,
        };
        assert!(
            matches!(error, AppError::FileIO(message) if message.contains("Duplicate archive entry path"))
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_duplicate_stable_ids_in_domains_and_active_namespace(
    ) {
        let path = temp_project_path("v4-duplicate-stable-ids");

        let manifests = vec![
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [
                    { "id": "table-1", "name": "a", "file": "data/a.sptb" },
                    { "id": "table-1", "name": "b", "file": "data/b.sptb" }
                ],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [],
                "tabulateFiles": [],
                "snapshotFiles": []
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [
                    { "id": "graph-1", "name": "a", "file": "data/a.spgh" },
                    { "id": "graph-1", "name": "b", "file": "data/b.spgh" }
                ],
                "folders": [],
                "fitYByXFiles": [],
                "tabulateFiles": [],
                "snapshotFiles": []
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "reportFiles": [
                    { "id": "report-1", "name": "a", "file": "data/a.sprp", "kind": "report" },
                    { "id": "report-1", "name": "b", "file": "data/b.sprp", "kind": "report" }
                ],
                "fitYByXFiles": [],
                "tabulateFiles": [],
                "snapshotFiles": []
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [
                    { "id": "fit-1", "name": "a", "file": "data/a.spf", "kind": "fitYByX" },
                    { "id": "fit-1", "name": "b", "file": "data/b.spf", "kind": "fitYByX" }
                ],
                "tabulateFiles": [],
                "snapshotFiles": []
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [],
                "tabulateFiles": [
                    { "id": "tab-1", "name": "a", "file": "data/a.spf", "kind": "tabulate" },
                    { "id": "tab-1", "name": "b", "file": "data/b.spf", "kind": "tabulate" }
                ],
                "snapshotFiles": []
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [],
                "tabulateFiles": [],
                "snapshotFiles": [
                    { "id": "snap-1", "name": "a", "file": "snapshots/a.spf" },
                    { "id": "snap-1", "name": "b", "file": "snapshots/b.spf" }
                ]
            }),
            json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [
                    { "id": "shared-id", "name": "fit", "file": "data/fit.spf", "kind": "fitYByX" }
                ],
                "tabulateFiles": [
                    { "id": "shared-id", "name": "tab", "file": "data/tab.spf", "kind": "tabulate" }
                ],
                "snapshotFiles": []
            }),
        ];

        for manifest in manifests {
            let file = std::fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
                .unwrap();
            zip.finish().unwrap();

            let error = match read_project_file(path.to_str().unwrap()) {
                Ok(_) => panic!("expected duplicate stable-id manifest read to fail"),
                Err(error) => error,
            };
            assert!(
                matches!(error, AppError::FileIO(message) if message.contains("Duplicate") && message.contains("stable id"))
            );
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validate_archive_rejects_indexed_body_id_or_name_parity_mismatches() {
        let source_path = temp_project_path("validate-v4-indexed-parity-source");
        let mismatched_path = temp_project_path("validate-v4-indexed-parity-mismatch");

        let bundle = build_bundle(
            "Project".to_string(),
            "4.0.0".to_string(),
            "2026-09-01T00:00:00Z".to_string(),
            vec![table_doc("table-1", "data")],
            vec![graph_doc("graph-1", "graph-data")],
            vec![fit_doc("fit-1", "fit-data")],
            vec![],
            vec![tabulate_doc("tab-1", "tab-data")],
            vec![],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![snapshot_doc("snap-1", "snap-data")],
        )
        .unwrap();
        write_project_archive(&bundle, source_path.to_str().unwrap()).unwrap();

        let graph_ref = &bundle.manifest.graphs[0];
        rewrite_named_entry_in_archive(
            &source_path,
            &mismatched_path,
            &graph_ref.file,
            br#"{"id":"graph-1","name":"wrong-name","version":"1"}"#,
        )
        .unwrap();
        let graph_error =
            validate_archive_manifest_and_entries(&mismatched_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(matches!(graph_error, AppError::FileIO(message) if message.contains("graph name")));

        let fit_ref = &bundle.manifest.fit_y_by_x_files[0];
        rewrite_named_entry_in_archive(
            &source_path,
            &mismatched_path,
            &fit_ref.file,
            br#"{"id":"fit-999","name":"fit-data"}"#,
        )
        .unwrap();
        let fit_error =
            validate_archive_manifest_and_entries(&mismatched_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(matches!(fit_error, AppError::FileIO(message) if message.contains("fit id")));

        let tab_ref = &bundle.manifest.tabulate_files[0];
        rewrite_named_entry_in_archive(
            &source_path,
            &mismatched_path,
            &tab_ref.file,
            br#"{"id":"tab-1","name":"wrong-tab"}"#,
        )
        .unwrap();
        let tab_error =
            validate_archive_manifest_and_entries(&mismatched_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(tab_error, AppError::FileIO(message) if message.contains("tabulate name"))
        );

        let snapshot_ref = &bundle.manifest.snapshot_files[0];
        rewrite_named_entry_in_archive(
            &source_path,
            &mismatched_path,
            &snapshot_ref.file,
            br#"{"id":"snap-1","name":"wrong-snapshot"}"#,
        )
        .unwrap();
        let snapshot_error =
            validate_archive_manifest_and_entries(&mismatched_path, &bundle.manifest, &[])
                .unwrap_err();
        assert!(
            matches!(snapshot_error, AppError::FileIO(message) if message.contains("snapshot name"))
        );

        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(mismatched_path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_invalid_indexed_root_extension_or_shape() {
        let path = temp_project_path("v4-invalid-indexed-paths");
        let cases = vec![
            json!({ "id": "fit-1", "name": "bad-root", "file": "snapshots/data.spf", "kind": "fitYByX" }),
            json!({ "id": "fit-1", "name": "bad-ext", "file": "data/data.json", "kind": "fitYByX" }),
            json!({ "id": "fit-1", "name": "bad-shape", "file": "data/folder/data.spf", "kind": "fitYByX" }),
        ];

        for (index, fit_entry) in cases.into_iter().enumerate() {
            let manifest = json!({
                "name": "Project",
                "version": "4.0.0",
                "createdAt": "now",
                "tables": [],
                "graphs": [],
                "folders": [],
                "fitYByXFiles": [fit_entry],
                "tabulateFiles": [],
                "snapshotFiles": []
            });

            let file = std::fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
                .unwrap();
            zip.finish().unwrap();

            let error = match read_project_file(path.to_str().unwrap()) {
                Ok(_) => panic!("expected invalid indexed path manifest read to fail"),
                Err(error) => error,
            };
            assert!(
                matches!(error, AppError::FileIO(message) if message.contains("Invalid fitYByX archive")),
                "case {} expected invalid indexed path error",
                index
            );
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_when_entry_name_differs_from_file_basename() {
        let path = temp_project_path("v4-name-basename-mismatch");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [
                { "id": "fit-1", "name": "DisplayName", "file": "data/data.spf", "kind": "fitYByX" }
            ],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("data/data.spf", opts).unwrap();
        zip.write_all(br#"{"id":"fit-1","name":"DisplayName"}"#)
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected v4 name/path mismatch to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("basename")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_table_body_name_mismatch() {
        let path = temp_project_path("v4-table-body-name-mismatch");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [
                { "id": "table-1", "name": "data", "file": "data/data.sptb" }
            ],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("data/data.sptb", opts).unwrap();
        zip.write_all(
            br#"{"id":"table-1","name":"stale-name","sourceType":"manual","version":"1","columns":[],"rows":[]}"#,
        )
        .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected v4 table body-name mismatch to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("table name")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_graph_body_name_mismatch() {
        let path = temp_project_path("v4-graph-body-name-mismatch");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [
                { "id": "graph-1", "name": "data", "file": "data/data.spgh" }
            ],
            "folders": [],
            "fitYByXFiles": [],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("data/data.spgh", opts).unwrap();
        zip.write_all(br#"{"id":"graph-1","name":"stale-name","version":"1"}"#)
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected v4 graph body-name mismatch to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("graph name")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_indexed_body_name_mismatch() {
        let path = temp_project_path("v4-indexed-body-name-mismatch");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [
                { "id": "fit-1", "name": "data", "file": "data/data.spf", "kind": "fitYByX" }
            ],
            "tabulateFiles": [],
            "snapshotFiles": [
                { "id": "snap-1", "name": "snap", "file": "snapshots/snap.spf" }
            ]
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("data/data.spf", opts).unwrap();
        zip.write_all(br#"{"id":"fit-1","name":"stale-fit"}"#)
            .unwrap();
        zip.start_file("snapshots/snap.spf", opts).unwrap();
        zip.write_all(br#"{"id":"snap-1","name":"stale-snapshot"}"#)
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected v4 indexed body-name mismatch to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("document name")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_accepts_legacy_spf_snapshot_entry() {
        let path = temp_project_path("v4-legacy-spf-snapshot");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByXFiles": [],
            "tabulateFiles": [],
            "snapshotFiles": [
                { "id": "snap-1", "name": "snap", "file": "snapshots/snap.spf" }
            ]
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.start_file("snapshots/snap.spf", opts).unwrap();
        zip.write_all(br#"{"id":"snap-1","name":"snap"}"#).unwrap();
        zip.finish().unwrap();

        let bundle = read_project_file(path.to_str().unwrap()).unwrap();
        assert_eq!(bundle.snapshots[0]["id"], "snap-1");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_rejects_v4_manifest_with_missing_indexed_fit_entry() {
        let path = temp_project_path("v4-missing-fit-index");
        let manifest = json!({
            "name": "Project",
            "version": "4.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByX": [],
            "fitYByXFolders": {},
            "tabulates": [],
            "tabulateFolders": {},
            "fitYByXFiles": [
                { "id": "fit-1", "name": "data", "file": "data/data.spf", "kind": "fitYByX" }
            ],
            "tabulateFiles": [],
            "snapshotFiles": []
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        zip.finish().unwrap();

        let error = match read_project_file(path.to_str().unwrap()) {
            Ok(_) => panic!("expected v4 archive read to fail"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::FileIO(message) if message.contains("data/data.spf")));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_project_file_prefers_legacy_inline_fit_tabulate_and_aggregate_snapshots_when_indexes_absent(
    ) {
        let path = temp_project_path("legacy-inline-fallback");
        let fit = fit_doc("fit-1", "fit-inline");
        let tabulate = tabulate_doc("tab-1", "tab-inline");
        let snapshot = snapshot_doc("snap-1", "snap-inline");

        let manifest = json!({
            "name": "Project",
            "version": "3.0.0",
            "createdAt": "now",
            "tables": [],
            "graphs": [],
            "folders": [],
            "fitYByX": [fit],
            "fitYByXFolders": {"fit-1": "legacy"},
            "tabulates": [tabulate],
            "tabulateFolders": {"tab-1": "legacy"}
        });

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();

        zip.start_file(".snapshots.json", opts).unwrap();
        zip.write_all(
            serde_json::to_vec(&vec![snapshot.clone()])
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        zip.finish().unwrap();

        let bundle = read_project_file(path.to_str().unwrap()).unwrap();
        assert_eq!(bundle.fit_y_by_x.len(), 1);
        assert_eq!(bundle.tabulates.len(), 1);
        assert_eq!(bundle.snapshots, vec![snapshot]);

        let _ = std::fs::remove_file(path);
    }
}
