//! Spprj archive layer.
//!
//! v2 `.spprj` files are ZIP containers whose internal layout mirrors the
//! user-facing folder tree inside the DIRECTORY tab. Each table and graph
//! lives at the path the user sees in the UI:
//!
//! ```text
//! manifest.json                ProjectManifest (project metadata + index)
//! <folder>/<name>.sptb         TableDoc as JSON (one per dataset)
//! <folder>/<name>.spgh         GraphDoc as JSON (one per graph builder)
//! .history.json                opaque [HistoryEntry]    (optional)
//! .snapshots.json              opaque [Snapshot]        (optional)
//! ```
//!
//! Extracting the archive yields a tidy directory tree the user can browse
//! with any zip tool — exactly what they see inside StatsPlayground.
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

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::models::distribution::DistributionLoadStatusV1;

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
    #[serde(default)]
    pub tabulates: Vec<serde_json::Value>,
    #[serde(default)]
    pub tabulate_folders: HashMap<String, String>,
    #[serde(default)]
    pub distributions: Vec<DistributionEntryRefV1>,
    #[serde(default)]
    pub distribution_folders: HashMap<String, String>,
    #[serde(default)]
    pub derived_formulas: Vec<DerivedFormulaEntryRefV1>,
    #[serde(default)]
    pub distribution_issues: Vec<Value>,
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionEntryRefV1 {
    pub analysis_id: String,
    pub name: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaEntryRefV1 {
    pub formula_id: String,
    pub analysis_id: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionDocV1 {
    pub schema_version: String,
    pub analysis_id: String,
    pub name: String,
    pub source_dataset_id: String,
    pub status: String,
    pub current_config: Value,
    #[serde(default)]
    pub load_status: DistributionLoadStatusV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_envelope: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaDocV1 {
    pub formula_id: String,
    pub schema_version: String,
    pub analysis_id: String,
    pub source_dataset_id: String,
    pub source_column_ids: Vec<String>,
    pub output_column_name: String,
    pub ast: Value,
    pub fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionArchiveEnvelopeV1 {
    pub schema_version: String,
    pub body: DistributionDocV1,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DistributionArchiveRecordV1 {
    Parsed(DistributionArchiveEnvelopeV1),
    UnknownVersion {
        analysis_id: String,
        schema_version: String,
        raw_envelope: Value,
    },
    Corrupt {
        analysis_id: String,
        raw_text: String,
    },
}

impl DistributionArchiveRecordV1 {
    fn analysis_id(&self) -> &str {
        match self {
            Self::Parsed(envelope) => &envelope.body.analysis_id,
            Self::UnknownVersion { analysis_id, .. } | Self::Corrupt { analysis_id, .. } => {
                analysis_id
            }
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedFormulaArchiveEnvelopeV1 {
    pub schema_version: String,
    pub body: DerivedFormulaDocV1,
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
    pub tabulates: Vec<Value>,
    pub distributions: Vec<DistributionArchiveRecordV1>,
    pub derived_formulas: Vec<DerivedFormulaArchiveEnvelopeV1>,
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

    let history = read_entry_bytes(&mut zip, ".history.json")
        .or_else(|| read_entry_bytes(&mut zip, "history.json"))
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let snapshots = read_entry_bytes(&mut zip, ".snapshots.json")
        .or_else(|| read_entry_bytes(&mut zip, "snapshots.json"))
        .map(|b| serde_json::from_slice::<Vec<Value>>(&b).unwrap_or_default())
        .unwrap_or_default();
    let tabulates = manifest.tabulates.clone();
    let mut distributions = Vec::with_capacity(manifest.distributions.len());
    for entry in &manifest.distributions {
        let Some(bytes) = read_entry_bytes(&mut zip, &entry.file) else {
            distributions.push(DistributionArchiveRecordV1::Corrupt {
                analysis_id: entry.analysis_id.clone(),
                raw_text: String::new(),
            });
            continue;
        };
        let raw_text = String::from_utf8_lossy(&bytes).into_owned();
        let Ok(raw_envelope) = serde_json::from_slice::<Value>(&bytes) else {
            distributions.push(DistributionArchiveRecordV1::Corrupt {
                analysis_id: entry.analysis_id.clone(),
                raw_text,
            });
            continue;
        };
        let schema_version = raw_envelope
            .get("schemaVersion")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        if schema_version != "1" {
            distributions.push(DistributionArchiveRecordV1::UnknownVersion {
                analysis_id: entry.analysis_id.clone(),
                schema_version,
                raw_envelope,
            });
            continue;
        }
        match serde_json::from_value::<DistributionArchiveEnvelopeV1>(raw_envelope) {
            Ok(envelope) => distributions.push(DistributionArchiveRecordV1::Parsed(envelope)),
            Err(_) => distributions.push(DistributionArchiveRecordV1::Corrupt {
                analysis_id: entry.analysis_id.clone(),
                raw_text,
            }),
        }
    }
    let mut derived_formulas = Vec::with_capacity(manifest.derived_formulas.len());
    for entry in &manifest.derived_formulas {
        let bytes = read_entry_bytes(&mut zip, &entry.file).ok_or_else(|| {
            AppError::FileIO(format!("Missing derived formula entry: {}", entry.file))
        })?;
        let envelope = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::FileIO(format!("Invalid derived formula file {}: {error}", entry.file))
        })?;
        derived_formulas.push(envelope);
    }

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        tabulates,
        distributions,
        derived_formulas,
        history,
        snapshots,
    })
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
        tabulates: Vec::new(),
        tabulate_folders: HashMap::new(),
        distributions: Vec::new(),
        distribution_folders: HashMap::new(),
        derived_formulas: Vec::new(),
        distribution_issues: Vec::new(),
    };

    Ok(ProjectBundle {
        manifest,
        tables,
        graphs,
        tabulates: Vec::new(),
        distributions: Vec::new(),
        derived_formulas: Vec::new(),
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
/// themselves carry no folder information. The writer now emits stable
/// archive paths based only on ids: `tables/<dataset-id>.sptb` and
/// `graphs/<graph-id>.spgh`.
pub fn build_bundle(
    name: String,
    version: String,
    created_at: String,
    tables: Vec<TableDoc>,
    graphs: Vec<GraphDoc>,
    tabulates: Vec<Value>,
    distributions: Vec<DistributionArchiveEnvelopeV1>,
    derived_formulas: Vec<DerivedFormulaArchiveEnvelopeV1>,
    distribution_issues: Vec<Value>,
    folders: Vec<String>,
    table_folders: &HashMap<String, String>,
    graph_folders: &HashMap<String, String>,
    tabulate_folders: &HashMap<String, String>,
    distribution_folders: &HashMap<String, String>,
    history: Vec<Value>,
    snapshots: Vec<Value>,
) -> ProjectBundle {
    let mut table_refs: Vec<TableEntryRef> = Vec::with_capacity(tables.len());
    for t in tables.iter() {
        table_refs.push(TableEntryRef {
            id: t.id.clone(),
            name: t.name.clone(),
            file: format!("tables/{}.sptb", t.id),
        });
    }

    let mut graph_refs: Vec<GraphEntryRef> = Vec::with_capacity(graphs.len());
    for g in graphs.iter() {
        graph_refs.push(GraphEntryRef {
            id: g.id.clone(),
            name: g.name.clone(),
            file: format!("graphs/{}.spgh", g.id),
        });
    }

    let distribution_refs = distributions
        .iter()
        .map(|envelope| DistributionEntryRefV1 {
            analysis_id: envelope.body.analysis_id.clone(),
            name: envelope.body.name.clone(),
            file: format!("distributions/{}.spdist", envelope.body.analysis_id),
        })
        .collect();
    let derived_formula_refs = derived_formulas
        .iter()
        .map(|envelope| DerivedFormulaEntryRefV1 {
            formula_id: envelope.body.formula_id.clone(),
            analysis_id: envelope.body.analysis_id.clone(),
            file: format!("derived-formulas/{}.spformula", envelope.body.formula_id),
        })
        .collect();

    // Collapse `folders` to a sorted, deduplicated, normalized list. Includes
    // any implicit ancestor folders for completeness so an extractor sees the
    // full tree even if the user only created `a/b/c` directly.
    let normalized_folders = normalize_folder_list(folders);

    ProjectBundle {
        manifest: ProjectManifest {
            name,
            version,
            created_at,
            tables: table_refs,
            graphs: graph_refs,
            folders: normalized_folders,
            table_folders: Some(table_folders.clone()),
            graph_folders: Some(graph_folders.clone()),
            tabulates: tabulates.clone(),
            tabulate_folders: tabulate_folders.clone(),
            distributions: distribution_refs,
            distribution_folders: distribution_folders.clone(),
            derived_formulas: derived_formula_refs,
            distribution_issues,
        },
        tables,
        graphs,
        tabulates,
        distributions: distributions
            .into_iter()
            .map(|envelope| {
                if let Some(raw_envelope) = envelope.body.raw_envelope.clone() {
                    return DistributionArchiveRecordV1::UnknownVersion {
                        analysis_id: envelope.body.analysis_id.clone(),
                        schema_version: envelope.body.schema_version.clone(),
                        raw_envelope,
                    };
                }
                if let Some(raw_text) = envelope.body.raw_text.clone() {
                    return DistributionArchiveRecordV1::Corrupt {
                        analysis_id: envelope.body.analysis_id.clone(),
                        raw_text,
                    };
                }
                DistributionArchiveRecordV1::Parsed(envelope)
            })
            .collect(),
        derived_formulas,
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
        let dir_opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        let manifest_bytes = serde_json::to_vec_pretty(&bundle.manifest)
            .map_err(|e| AppError::FileIO(e.to_string()))?;
        write_zip_entry(&mut zip, "manifest.json", &manifest_bytes, opts)?;

        // Emit explicit directory entries for every folder so extraction
        // produces the full tree (including empty folders the user created).
        // Also include implicit ancestors of any table/graph file path.
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
        // Sort so the archive's central directory has a stable order.
        let mut dirs_sorted: Vec<String> = all_dirs.into_iter().collect();
        dirs_sorted.sort();
        for d in &dirs_sorted {
            zip.add_directory(format!("{}/", d), dir_opts)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }

        // Map each TableDoc / GraphDoc by id so we can pair them with the
        // manifest entry that holds the authoritative archive path.
        let table_by_id: HashMap<&str, &TableDoc> =
            bundle.tables.iter().map(|t| (t.id.as_str(), t)).collect();
        let graph_by_id: HashMap<&str, &GraphDoc> =
            bundle.graphs.iter().map(|g| (g.id.as_str(), g)).collect();
        let distribution_by_id: HashMap<&str, &DistributionArchiveRecordV1> = bundle
            .distributions
            .iter()
            .map(|record| (record.analysis_id(), record))
            .collect();
        let formula_by_id: HashMap<&str, &DerivedFormulaArchiveEnvelopeV1> = bundle
            .derived_formulas
            .iter()
            .map(|envelope| (envelope.body.formula_id.as_str(), envelope))
            .collect();

        for entry in &bundle.manifest.tables {
            if let Some(doc) = table_by_id.get(entry.id.as_str()) {
                let bytes = serde_json::to_vec(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
                write_zip_entry(&mut zip, &entry.file, &bytes, opts)?;
            }
        }
        for entry in &bundle.manifest.graphs {
            if let Some(doc) = graph_by_id.get(entry.id.as_str()) {
                let bytes = serde_json::to_vec(doc).map_err(|e| AppError::FileIO(e.to_string()))?;
                write_zip_entry(&mut zip, &entry.file, &bytes, opts)?;
            }
        }
        for entry in &bundle.manifest.distributions {
            if let Some(record) = distribution_by_id.get(entry.analysis_id.as_str()) {
                let bytes = match record {
                    DistributionArchiveRecordV1::Parsed(envelope) => serde_json::to_vec(envelope)
                        .map_err(|error| AppError::FileIO(error.to_string()))?,
                    DistributionArchiveRecordV1::UnknownVersion { raw_envelope, .. } => {
                        serde_json::to_vec(raw_envelope)
                            .map_err(|error| AppError::FileIO(error.to_string()))?
                    }
                    DistributionArchiveRecordV1::Corrupt { raw_text, .. } => {
                        raw_text.as_bytes().to_vec()
                    }
                };
                write_zip_entry(&mut zip, &entry.file, &bytes, opts)?;
            }
        }
        for entry in &bundle.manifest.derived_formulas {
            if let Some(envelope) = formula_by_id.get(entry.formula_id.as_str()) {
                let bytes = serde_json::to_vec(envelope)
                    .map_err(|error| AppError::FileIO(error.to_string()))?;
                write_zip_entry(&mut zip, &entry.file, &bytes, opts)?;
            }
        }
        if !bundle.history.is_empty() {
            let bytes =
                serde_json::to_vec(&bundle.history).map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, ".history.json", &bytes, opts)?;
        }
        if !bundle.snapshots.is_empty() {
            let bytes = serde_json::to_vec(&bundle.snapshots)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            write_zip_entry(&mut zip, ".snapshots.json", &bytes, opts)?;
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
    zip.start_file(name, opts)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
    zip.write_all(data)
        .map_err(|e| AppError::FileIO(e.to_string()))?;
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
        let table_folders = HashMap::from([(String::from("table-id"), String::from("Raw/2026"))]);
        let graph_folders = HashMap::from([(String::from("graph-id"), String::from("Reports"))]);

        let bundle = build_bundle(
            "Project".into(),
            "3.0.0".into(),
            "now".into(),
            vec![table],
            vec![graph],
            vec![],
            vec![],
            vec![],
            vec![],
            vec!["Raw/2026".into(), "Reports".into()],
            &table_folders,
            &graph_folders,
            &HashMap::new(),
            &HashMap::new(),
            vec![],
            vec![],
        );

        assert_eq!(bundle.manifest.tables[0].file, "tables/table-id.sptb");
        assert_eq!(bundle.manifest.graphs[0].file, "graphs/graph-id.spgh");
        assert_eq!(bundle.manifest.table_folders.as_ref(), Some(&table_folders));
        assert_eq!(bundle.manifest.graph_folders.as_ref(), Some(&graph_folders));
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
            tabulates: vec![],
            tabulate_folders: HashMap::new(),
            distributions: vec![],
            distribution_folders: HashMap::new(),
            derived_formulas: vec![],
            distribution_issues: vec![],
        };

        let json = serde_json::to_vec(&manifest).expect("serialize manifest");
        let round_trip: ProjectManifest = serde_json::from_slice(&json).expect("deserialize manifest");

        assert_eq!(round_trip.table_folders, Some(HashMap::new()));
        assert_eq!(round_trip.graph_folders, Some(HashMap::new()));
    }

    use serde_json::json;

    fn temp_project_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "statsplayground-spprj-{}-{}.spprj",
            name,
            uuid::Uuid::new_v4()
        ))
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
            vec![tabulate.clone()],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &folders,
            &HashMap::new(),
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.tabulates, vec![tabulate.clone()]);
        assert_eq!(loaded.manifest.tabulate_folders, folders);
        assert_eq!(loaded.tabulates, vec![tabulate]);

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
    fn distribution_manifest_round_trip_preserves_distribution_and_formula_folder_maps() {
        let path = temp_project_path("distribution-round-trip");
        let distribution = DistributionArchiveEnvelopeV1 {
            schema_version: "1".to_string(),
            body: DistributionDocV1 {
                schema_version: "1".to_string(),
                analysis_id: "dist-001".to_string(),
                name: "Distribution 1".to_string(),
                source_dataset_id: "ds-42".to_string(),
                status: "ready".to_string(),
                current_config: json!({
                    "mode": "continuous",
                    "filterExpr": {
                        "kind": "isNull",
                        "fieldId": "region"
                    }
                }),
                load_status: DistributionLoadStatusV1::Ready,
                raw_envelope: None,
                raw_text: None,
            },
        };
        let formula = DerivedFormulaArchiveEnvelopeV1 {
            schema_version: "1".to_string(),
            body: DerivedFormulaDocV1 {
                formula_id: "formula-001".to_string(),
                schema_version: "1".to_string(),
                analysis_id: "dist-001".to_string(),
                source_dataset_id: "ds-42".to_string(),
                source_column_ids: vec!["sales-amount-id".to_string()],
                output_column_name: "Standardized Sales".to_string(),
                ast: json!({ "kind": "column", "columnId": "sales-amount-id" }),
                fingerprint: "sha256:formula-001".to_string(),
            },
        };
        let distribution_folders =
            HashMap::from([("dist-001".to_string(), "Analyses/Revenue".to_string())]);

        let bundle = build_bundle(
            "Project".to_string(),
            "3.0.0".to_string(),
            "2026-08-26T00:00:00Z".to_string(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![distribution.clone()],
            vec![formula.clone()],
            Vec::new(),
            Vec::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &distribution_folders,
            Vec::new(),
            Vec::new(),
        );

        write_project_archive(&bundle, path.to_str().unwrap()).unwrap();
        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert_eq!(loaded.manifest.distributions[0].analysis_id, "dist-001");
        assert_eq!(loaded.manifest.distributions[0].file, "distributions/dist-001.spdist");
        assert_eq!(loaded.manifest.derived_formulas[0].formula_id, "formula-001");
        assert_eq!(
            loaded.manifest.derived_formulas[0].file,
            "derived-formulas/formula-001.spformula"
        );
        assert_eq!(loaded.manifest.distribution_folders, distribution_folders);
        assert_eq!(
            loaded.distributions,
            vec![DistributionArchiveRecordV1::Parsed(distribution)]
        );
        assert_eq!(loaded.derived_formulas, vec![formula]);
        assert!(loaded.manifest.distribution_issues.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn distribution_unknown_version_is_preserved_and_corruption_is_isolated() {
        let path = temp_project_path("distribution-isolation");
        let manifest = json!({
            "name": "Isolation Project",
            "version": "3.0.0",
            "createdAt": "2026-08-26T00:00:00Z",
            "tables": [],
            "graphs": [],
            "folders": ["Analyses"],
            "distributions": [
                {
                    "analysisId": "dist-ready",
                    "name": "Ready",
                    "file": "distributions/dist-ready.spdist"
                },
                {
                    "analysisId": "dist-future",
                    "name": "Future",
                    "file": "distributions/dist-future.spdist"
                },
                {
                    "analysisId": "dist-corrupt",
                    "name": "Corrupt",
                    "file": "distributions/dist-corrupt.spdist"
                }
            ],
            "distributionFolders": {
                "dist-future": "Analyses"
            }
        });
        let ready = json!({
            "schemaVersion": "1",
            "body": {
                "schemaVersion": "1",
                "analysisId": "dist-ready",
                "name": "Ready",
                "sourceDatasetId": "ds-ready",
                "status": "ready",
                "currentConfig": {}
            }
        });
        let future = json!({
            "schemaVersion": "99",
            "body": {
                "schemaVersion": "99",
                "analysisId": "dist-future",
                "name": "Future",
                "sourceDatasetId": "ds-future",
                "status": "ready",
                "currentConfig": { "futureOption": true }
            }
        });
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        write_zip_entry(
            &mut zip,
            "manifest.json",
            &serde_json::to_vec(&manifest).unwrap(),
            opts,
        )
        .unwrap();
        write_zip_entry(
            &mut zip,
            "distributions/dist-ready.spdist",
            &serde_json::to_vec(&ready).unwrap(),
            opts,
        )
        .unwrap();
        write_zip_entry(
            &mut zip,
            "distributions/dist-future.spdist",
            &serde_json::to_vec(&future).unwrap(),
            opts,
        )
        .unwrap();
        write_zip_entry(
            &mut zip,
            "distributions/dist-corrupt.spdist",
            b"{not valid json",
            opts,
        )
        .unwrap();
        zip.finish().unwrap();

        let loaded = read_project_file(path.to_str().unwrap()).unwrap();

        assert!(matches!(
            &loaded.distributions[0],
            DistributionArchiveRecordV1::Parsed(envelope)
                if envelope.body.analysis_id == "dist-ready"
        ));
        assert!(matches!(
            &loaded.distributions[1],
            DistributionArchiveRecordV1::UnknownVersion { schema_version, raw_envelope, .. }
                if schema_version == "99" && raw_envelope == &future
        ));
        assert!(matches!(
            &loaded.distributions[2],
            DistributionArchiveRecordV1::Corrupt { raw_text, .. }
                if raw_text == "{not valid json"
        ));
        assert_eq!(
            loaded.manifest.distribution_folders.get("dist-future"),
            Some(&"Analyses".to_string())
        );

        let saved_path = temp_project_path("distribution-isolation-resaved");
        write_project_archive(&loaded, saved_path.to_str().unwrap()).unwrap();
        let saved_bytes = std::fs::read(&saved_path).unwrap();
        let mut saved_zip = zip::ZipArchive::new(std::io::Cursor::new(saved_bytes)).unwrap();
        let future_bytes = read_entry_bytes(
            &mut saved_zip,
            "distributions/dist-future.spdist",
        )
        .unwrap();
        let corrupt_bytes = read_entry_bytes(
            &mut saved_zip,
            "distributions/dist-corrupt.spdist",
        )
        .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&future_bytes).unwrap(), future);
        assert_eq!(corrupt_bytes, b"{not valid json");

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(saved_path);
    }
}
