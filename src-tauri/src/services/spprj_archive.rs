//! Spprj archive layer.
//!
//! New `.spprj` files are ZIP containers laid out as:
//! ```text
//! manifest.json          ProjectManifest (project metadata + entry index)
//! tables/<id>.sptb       TableDoc as JSON (one entry per dataset)
//! graphs/<id>.spgh       GraphDoc as JSON (one entry per graph builder)
//! history.json           opaque [HistoryEntry]    (optional)
//! snapshots.json         opaque [Snapshot]        (optional)
//! ```
//!
//! Each `.sptb` / `.spgh` entry is *also* a valid standalone file: extracting
//! it from the archive produces a file the user can open by itself or share.
//!
//! A small backward-compatibility path detects legacy single-file JSON
//! (`.spprj` files written before this refactor) by sniffing the first byte
//! and parses them via the same `LegacySpprj` shape that used to exist.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Seek, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

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
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableEntryRef {
    pub id: String,
    pub name: String,
    /// Relative path inside the archive, e.g. `tables/<id>.sptb`.
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntryRef {
    pub id: String,
    /// Relative path inside the archive, e.g. `graphs/<id>.spgh`.
    pub file: String,
}

/// One table file (`.sptb`). Self-contained: includes its own id/name so that
/// importing a standalone `.sptb` back into a project doesn't lose anything.
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
/// manifest can index it.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphDoc {
    pub id: String,
    /// Doc format version.
    #[serde(default = "default_doc_version")]
    pub version: String,
    /// Frontend-owned opaque payload (everything except `id` / `version`).
    #[serde(flatten)]
    pub body: serde_json::Map<String, Value>,
}

fn default_doc_version() -> String { "1".to_string() }

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

    let mut tables = Vec::with_capacity(manifest.tables.len());
    for entry in &manifest.tables {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing table entry: {}", entry.file)))?;
        let doc: TableDoc = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::FileIO(format!("Invalid table file {}: {}", entry.file, e)))?;
        tables.push(doc);
    }
    let mut graphs = Vec::with_capacity(manifest.graphs.len());
    for entry in &manifest.graphs {
        let bytes = read_entry_bytes(&mut zip, &entry.file)
            .ok_or_else(|| AppError::FileIO(format!("Missing graph entry: {}", entry.file)))?;
        let doc = parse_graph_doc(&bytes, &entry.id)
            .map_err(|e| AppError::FileIO(format!("Invalid graph file {}: {}", entry.file, e)))?;
        graphs.push(doc);
    }

    let history = read_entry_bytes(&mut zip, "history.json")
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let snapshots = read_entry_bytes(&mut zip, "snapshots.json")
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();

    Ok(ProjectBundle { manifest, tables, graphs, history, snapshots })
}

fn read_entry_bytes<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<Vec<u8>> {
    let mut entry = zip.by_name(name).ok()?;
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out).ok()?;
    Some(out)
}

fn read_legacy_json(bytes: &[u8]) -> Result<ProjectBundle, AppError> {
    let legacy: LegacySpprj = serde_json::from_slice(bytes)
        .map_err(|e| AppError::FileIO(format!("Invalid project file: {}", e)))?;

    let mut tables = Vec::with_capacity(legacy.datasets.len());
    let mut table_refs = Vec::with_capacity(legacy.datasets.len());
    for ds in legacy.datasets {
        table_refs.push(TableEntryRef {
            id: ds.id.clone(),
            name: ds.name.clone(),
            file: format!("tables/{}.sptb", ds.id),
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
    // Try to lift `id`/`builderId` out for the manifest; otherwise synthesize.
    let mut graphs = Vec::new();
    let mut graph_refs = Vec::new();
    if let Some(gbs) = legacy.graph_builders {
        for (idx, raw) in gbs.into_iter().enumerate() {
            let (id, body) = lift_id(raw, idx);
            graph_refs.push(GraphEntryRef {
                id: id.clone(),
                file: format!("graphs/{}.spgh", id),
            });
            graphs.push(GraphDoc { id, version: default_doc_version(), body });
        }
    }

    let manifest = ProjectManifest {
        name: legacy.name,
        version: if legacy.version.is_empty() { "0.1.0".into() } else { legacy.version },
        created_at: legacy.created_at,
        tables: table_refs,
        graphs: graph_refs,
    };

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        history: legacy.history.unwrap_or_default(),
        snapshots: legacy.snapshots.unwrap_or_default(),
    })
}

/// Pull an `id`/`builderId` field out of an opaque graph builder JSON value
/// for use in the manifest, returning the body as a Map. The id and version
/// are *removed* from the returned body so the GraphDoc that flattens it
/// won't emit them twice on serialization.
fn lift_id(raw: Value, fallback_idx: usize) -> (String, serde_json::Map<String, Value>) {
    let mut map = match raw {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| map.remove("builderId").and_then(|v| v.as_str().map(String::from)))
        .unwrap_or_else(|| format!("graph_{}", fallback_idx));
    map.remove("version");
    (id, map)
}

// ----------------------------------------------------------------------------
// Write API
// ----------------------------------------------------------------------------

/// Build a `ProjectBundle` from per-doc inputs. Fills in the manifest's table
/// and graph entry refs from the docs themselves.
pub fn build_bundle(
    name: String,
    version: String,
    created_at: String,
    tables: Vec<TableDoc>,
    graphs: Vec<GraphDoc>,
    history: Vec<Value>,
    snapshots: Vec<Value>,
) -> ProjectBundle {
    let table_refs: Vec<_> = tables.iter().map(|t| TableEntryRef {
        id: t.id.clone(),
        name: t.name.clone(),
        file: format!("tables/{}.sptb", t.id),
    }).collect();
    let graph_refs: Vec<_> = graphs.iter().map(|g| GraphEntryRef {
        id: g.id.clone(),
        file: format!("graphs/{}.spgh", g.id),
    }).collect();
    ProjectBundle {
        manifest: ProjectManifest {
            name, version, created_at,
            tables: table_refs,
            graphs: graph_refs,
        },
        tables,
        graphs,
        history,
        snapshots,
    }
}

/// Write a `ProjectBundle` to disk as a zip archive at `path`.
///
/// Strategy: write to `<path>.tmp` first, then rename over the original. Gives
/// us a much safer path than a direct in-place overwrite on Windows.
pub fn write_project_archive(bundle: &ProjectBundle, path: &str) -> Result<(), AppError> {
    let tmp_path = format!("{}.tmp", path);
    {
        let file = std::fs::File::create(&tmp_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let manifest_bytes = serde_json::to_vec_pretty(&bundle.manifest)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        write_zip_entry(&mut zip, "manifest.json", &manifest_bytes, opts)?;

        for t in &bundle.tables {
            let entry_path = format!("tables/{}.sptb", t.id);
            let bytes = serde_json::to_vec(t)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, &entry_path, &bytes, opts)?;
        }
        for g in &bundle.graphs {
            let entry_path = format!("graphs/{}.spgh", g.id);
            let bytes = serde_json::to_vec(g)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, &entry_path, &bytes, opts)?;
        }
        if !bundle.history.is_empty() {
            let bytes = serde_json::to_vec(&bundle.history)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, "history.json", &bytes, opts)?;
        }
        if !bundle.snapshots.is_empty() {
            let bytes = serde_json::to_vec(&bundle.snapshots)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, "snapshots.json", &bytes, opts)?;
        }
        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
    }
    if std::path::Path::new(path).exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn write_zip_entry<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    data: &[u8],
    opts: zip::write::SimpleFileOptions,
) -> Result<(), AppError> {
    zip.start_file(name, opts).map_err(|e| AppError::FileIO(e.to_string()))?;
    zip.write_all(data).map_err(|e| AppError::FileIO(e.to_string()))?;
    Ok(())
}

// ----------------------------------------------------------------------------
// Single-file table / graph IO (for share / re-import workflows)
// ----------------------------------------------------------------------------

/// Write a single `TableDoc` to a `.sptb` file (just JSON on disk for now).
pub fn write_table_file(doc: &TableDoc, path: &str) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(doc)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
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
    let bytes = serde_json::to_vec_pretty(doc)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Read a `.spgh` file from disk into a `GraphDoc`.
pub fn read_graph_file(path: &str) -> Result<GraphDoc, AppError> {
    let bytes = std::fs::read(path)?;
    parse_graph_doc(&bytes, "")
        .map_err(|e| AppError::FileIO(format!("Invalid .spgh file: {}", e)))
}

/// Tolerant `.spgh` parser. Reads the bytes into a generic `serde_json::Value`
/// first so legacy files written before this fix — which carry a duplicate
/// top-level `id` key (one from the named struct field, one re-emitted by the
/// flattened `body`) — still load. `serde_json::Map` keeps only the last value
/// for duplicate keys, so the resulting map has a single `id` entry. We then
/// lift `id` and `version` into the named struct fields so `body` no longer
/// carries them. `fallback_id` is used when the file omits `id` entirely.
fn parse_graph_doc(bytes: &[u8], fallback_id: &str) -> Result<GraphDoc, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut map = match value {
        Value::Object(m) => m,
        _ => return Err("graph file is not a JSON object".into()),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| map.remove("builderId").and_then(|v| v.as_str().map(String::from)))
        .unwrap_or_else(|| fallback_id.to_string());
    let version = map
        .remove("version")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(default_doc_version);
    Ok(GraphDoc { id, version, body: map })
}
