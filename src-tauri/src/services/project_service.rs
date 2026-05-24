use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::table::{ColumnDisplayProps, ColumnFormatInfo};
use crate::services::spprj_archive::{
    self, GraphDoc, ProjectBundle, TableColumn, TableColumnFormat, TableDoc,
};
use crate::state::AppState;

pub struct ProjectService<'a> {
    state: &'a AppState,
}

/// Result of opening a project, including restored history/snapshot data,
/// graph builder configurations, and folder layout. Field names mirror the
/// frontend API shape so this refactor is transparent to TypeScript callers.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResult {
    pub project: ProjectInfo,
    #[serde(default)]
    pub history: Vec<serde_json::Value>,
    #[serde(default)]
    pub snapshots: Vec<serde_json::Value>,
    #[serde(default)]
    pub graph_builders: Vec<serde_json::Value>,
    /// All folder paths that exist in the project (including empty ones).
    #[serde(default)]
    pub folders: Vec<String>,
    /// `datasetId -> folder path` (root datasets are simply absent from the map).
    #[serde(default)]
    pub table_folders: std::collections::HashMap<String, String>,
    /// `graphId -> folder path`.
    #[serde(default)]
    pub graph_folders: std::collections::HashMap<String, String>,
}

const SPPRJ_VERSION: &str = "2.0.0";

impl<'a> ProjectService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    /// Initialize a new in-memory project (no file on disk)
    pub fn init_project(&self) -> Result<ProjectInfo, AppError> {
        self.state.reset_db()?;

        let now = chrono_now();
        let project = ProjectInfo {
            name: "Untitled Project".to_string(),
            file_path: String::new(),
            created_at: now,
        };

        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Create a new project at the specified path. Writes an empty archive to
    /// disk so the file exists for subsequent saves.
    pub fn create_project(&self, name: &str, file_path: &str) -> Result<ProjectInfo, AppError> {
        self.state.reset_db()?;

        let now = chrono_now();
        let project = ProjectInfo {
            name: name.to_string(),
            file_path: file_path.to_string(),
            created_at: now.clone(),
        };

        let empty_folders: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let bundle = spprj_archive::build_bundle(
            name.to_string(),
            SPPRJ_VERSION.to_string(),
            now,
            Vec::new(), Vec::new(), Vec::new(),
            &empty_folders, &empty_folders,
            Vec::new(), Vec::new(),
        );
        spprj_archive::write_project_archive(&bundle, file_path)?;

        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        Ok(project)
    }

    /// Open an existing `.spprj` file. Auto-detects the new ZIP container vs
    /// the legacy single-file JSON format.
    pub fn open_project(
        &self,
        file_path: &str,
        progress_cb: Option<&dyn Fn(usize, usize, &str)>,
    ) -> Result<OpenProjectResult, AppError> {
        let bundle = spprj_archive::read_project_file(file_path)?;

        self.state.reset_db()?;

        let total = bundle.tables.len();
        for (idx, doc) in bundle.tables.iter().enumerate() {
            if let Some(cb) = &progress_cb { cb(idx, total, &doc.name); }
            self.restore_table_doc(doc)?;
        }
        if let Some(cb) = &progress_cb { cb(total, total, "完成"); }

        let project = ProjectInfo {
            name: bundle.manifest.name.clone(),
            file_path: file_path.to_string(),
            created_at: bundle.manifest.created_at.clone(),
        };

        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        *proj = Some(project.clone());

        // Folder for every file is derived from its archive path
        // (`dirname(entry.file)`). The manifest no longer carries a separate
        // `folder` field — the path IS the source of truth (issue #7).
        let mut table_folders: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for entry in &bundle.manifest.tables {
            if let Some(f) = spprj_archive::parent_folder(&entry.file) {
                if !f.is_empty() { table_folders.insert(entry.id.clone(), f); }
            }
        }
        let mut graph_folders: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for entry in &bundle.manifest.graphs {
            if let Some(f) = spprj_archive::parent_folder(&entry.file) {
                if !f.is_empty() { graph_folders.insert(entry.id.clone(), f); }
            }
        }
        let folders = bundle.manifest.folders.clone();

        // Re-pack graph docs into the opaque JSON shape the frontend
        // understands. The body map stored on disk no longer carries named
        // keys (they live on GraphDoc itself to avoid duplicate JSON keys),
        // so re-inject `id` / `name`. Folder is intentionally NOT injected
        // into the body — it flows via the separate `graphFolders` map.
        let graph_builders = bundle.graphs.into_iter()
            .map(|mut g| {
                g.body.insert("id".to_string(), serde_json::Value::String(g.id.clone()));
                if !g.name.is_empty() {
                    g.body.insert("name".to_string(), serde_json::Value::String(g.name.clone()));
                }
                serde_json::Value::Object(g.body)
            })
            .collect();

        Ok(OpenProjectResult {
            project,
            history: bundle.history,
            snapshots: bundle.snapshots,
            graph_builders,
            folders,
            table_folders,
            graph_folders,
        })
    }

    /// Save the current project state to disk as a new ZIP archive.
    ///
    /// Per issue #7, folder routing is supplied OUT-OF-BAND via
    /// `table_folders` and `graph_folders` (id → folder path). The file
    /// bodies themselves never carry folder info.
    pub fn save_project(
        &self,
        file_path: Option<&str>,
        history_data: Option<Vec<serde_json::Value>>,
        snapshots_data: Option<Vec<serde_json::Value>>,
        graph_builders_data: Option<Vec<serde_json::Value>>,
        folders: Option<Vec<String>>,
        table_folders: Option<std::collections::HashMap<String, String>>,
        graph_folders: Option<std::collections::HashMap<String, String>>,
    ) -> Result<(), AppError> {
        let mut proj = self.state.project.write()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let project = proj.as_mut()
            .ok_or_else(|| AppError::InvalidParam("No project is open".into()))?;

        if let Some(fp) = file_path {
            project.file_path = fp.to_string();
            if let Some(stem) = std::path::Path::new(fp).file_stem().and_then(|s| s.to_str()) {
                project.name = stem.to_string();
            }
        }
        if project.file_path.is_empty() {
            return Err(AppError::InvalidParam("Project has no file path".into()));
        }

        let save_path = project.file_path.clone();
        let save_name = project.name.clone();
        let save_created_at = project.created_at.clone();
        drop(proj);

        // Compose every dataset into a TableDoc. The doc body is folder-free
        // (issue #7); folder routing is supplied separately via the
        // `table_folders` map and consumed by `build_bundle` to derive
        // archive paths.
        let datasets = {
            let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
            db.list_datasets()?
        };
        let table_folders_map = table_folders.unwrap_or_default();
        let graph_folders_map = graph_folders.unwrap_or_default();
        let mut table_docs = Vec::with_capacity(datasets.len());
        for ds in &datasets {
            let doc = self.compose_table_doc(&ds.id)?;
            table_docs.push(doc);
        }

        // Graph docs are folder-free too — `compose_graph_docs` strips any
        // legacy in-body `folder` field via `lift_graph_meta`.
        let graph_docs = compose_graph_docs(graph_builders_data.unwrap_or_default());

        let bundle = spprj_archive::build_bundle(
            save_name,
            SPPRJ_VERSION.to_string(),
            save_created_at,
            table_docs,
            graph_docs,
            folders.unwrap_or_default(),
            &table_folders_map,
            &graph_folders_map,
            history_data.unwrap_or_default(),
            snapshots_data.unwrap_or_default(),
        );
        spprj_archive::write_project_archive(&bundle, &save_path)?;

        Ok(())
    }

    /// Get current project info
    pub fn get_current_project(&self) -> Result<Option<ProjectInfo>, AppError> {
        let proj = self.state.project.read()
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(proj.clone())
    }

    // ------------------------------------------------------------------
    // Per-dataset compose / restore — used by both project save/load AND
    // the standalone export/import commands. Centralizing these here keeps
    // the on-disk shape of a `.sptb` file in lock-step with what's stored
    // inside the project archive.
    // ------------------------------------------------------------------

    /// Build a `TableDoc` snapshot of a single dataset from the live DB +
    /// in-memory display props.
    pub fn compose_table_doc(&self, dataset_id: &str) -> Result<TableDoc, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        let display = self.state.column_display.lock()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let meta = db.get_dataset_meta(dataset_id)?;
        let table_name = format!("dataset_{}", dataset_id.replace('-', "_"));

        let mut col_stmt = db.conn().prepare(
            "SELECT col_name, col_type FROM _meta_columns WHERE dataset_id = $1 ORDER BY col_index"
        )?;
        let base_columns: Vec<(String, String)> = col_stmt
            .query_map(duckdb::params![dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let ds_display = display.get(dataset_id);
        let columns: Vec<TableColumn> = base_columns.iter().enumerate().map(|(i, (name, col_type))| {
            let dp = ds_display.and_then(|v| v.iter().find(|p| p.col_index == i));
            TableColumn {
                name: name.clone(),
                col_type: col_type.clone(),
                width: dp.and_then(|p| p.width),
                format: dp.and_then(|p| p.format.as_ref()).map(|f| TableColumnFormat {
                    kind: f.kind.clone(),
                    decimals: f.decimals,
                    currency: f.currency.clone(),
                }),
                extras: dp.and_then(|p| p.extras.clone()),
            }
        }).collect();

        let col_names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();

        // SELECT _row_id + every visible column. _row_id stays at index 0 in
        // the saved row arrays so restore can write it back verbatim.
        let select_cols = std::iter::once("\"_row_id\"".to_string())
            .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!("SELECT {} FROM \"{}\" ORDER BY \"_row_id\"", select_cols, table_name);
        let mut stmt = db.conn().prepare(&query)?;
        let total_cols = 1 + col_names.len();

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut result_rows = stmt.query([])?;
        while let Some(row) = result_rows.next()? {
            let mut row_values = Vec::with_capacity(total_cols);
            for i in 0..total_cols {
                let value: duckdb::types::Value = row.get(i)?;
                row_values.push(duckdb_to_json(value));
            }
            rows.push(row_values);
        }

        Ok(TableDoc {
            id: dataset_id.to_string(),
            name: meta.name,
            source_type: meta.source_type,
            version: "1".to_string(),
            columns,
            rows,
        })
    }

    /// Insert (or skip if already present) a `TableDoc` into the live DB and
    /// register its column display props. Returns the dataset id actually used
    /// (caller may want a fresh id when importing — see `import_table`).
    pub fn restore_table_doc(&self, doc: &TableDoc) -> Result<String, AppError> {
        let db = self.state.db.lock().map_err(|e| AppError::Database(e.to_string()))?;

        let col_names: Vec<String> = doc.columns.iter().map(|c| c.name.clone()).collect();
        let col_types: Vec<String> = doc.columns.iter().map(|c| c.col_type.clone()).collect();
        db.create_empty_table(&doc.id, &doc.name, &col_names, &col_types)?;

        if !doc.rows.is_empty() {
            let all_col_defs: Vec<String> = std::iter::once("\"_row_id\"".to_string())
                .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
                .collect();
            let col_list = all_col_defs.join(", ");
            let table_ident = format!("dataset_{}", doc.id.replace('-', "_"));

            for chunk in doc.rows.chunks(1000) {
                let values_lists: Vec<String> = chunk.iter().map(|row| {
                    let vals: Vec<String> = row.iter().map(|v| match v {
                        serde_json::Value::Null => "NULL".to_string(),
                        serde_json::Value::Number(n) => n.to_string(),
                        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                        serde_json::Value::Bool(b) => b.to_string(),
                        _ => format!("'{}'", v.to_string().replace('\'', "''")),
                    }).collect();
                    format!("({})", vals.join(", "))
                }).collect();

                let raw_sql = format!(
                    "INSERT INTO \"{}\" ({}) VALUES {}",
                    table_ident, col_list, values_lists.join(", ")
                );
                db.conn().execute_batch(&raw_sql)
                    .map_err(|e| AppError::Database(e.to_string()))?;
            }
        }

        // Update row count metadata.
        let row_count: i64 = db.conn().query_row(
            &format!("SELECT COUNT(*) FROM \"dataset_{}\"", doc.id.replace('-', "_")),
            [], |row| row.get(0),
        )?;
        db.conn().execute(
            "UPDATE _meta_datasets SET row_count = $1 WHERE id = $2",
            duckdb::params![row_count, doc.id],
        )?;

        // Re-register column display props.
        let mut display_props: Vec<ColumnDisplayProps> = Vec::new();
        for (i, col) in doc.columns.iter().enumerate() {
            if col.width.is_some() || col.format.is_some() || col.extras.is_some() {
                display_props.push(ColumnDisplayProps {
                    col_index: i,
                    width: col.width,
                    format: col.format.as_ref().map(|f| ColumnFormatInfo {
                        kind: f.kind.clone(),
                        decimals: f.decimals,
                        currency: f.currency.clone(),
                    }),
                    extras: col.extras.clone(),
                });
            }
        }
        if !display_props.is_empty() {
            let mut display = self.state.column_display.lock()
                .map_err(|e| AppError::Database(e.to_string()))?;
            display.insert(doc.id.clone(), display_props);
        }

        Ok(doc.id.clone())
    }

    // ------------------------------------------------------------------
    // Standalone .sptb / .spgh IO — for "share / export single table",
    // "import a .sptb into the current project", etc.
    // ------------------------------------------------------------------

    /// Export a single dataset to a standalone `.sptb` file on disk.
    pub fn export_table(&self, dataset_id: &str, file_path: &str) -> Result<(), AppError> {
        let doc = self.compose_table_doc(dataset_id)?;
        spprj_archive::write_table_file(&doc, file_path)
    }

    /// Export multiple datasets as `.sptb` files packaged into a ZIP archive.
    /// Each entry in `archive_paths` maps a dataset id to the `.sptb` file's
    /// path inside the zip (the `.sptb` extension is added automatically and
    /// duplicates are auto-suffixed with ` (2)`, ` (3)`, …). Datasets not
    /// present in the map fall back to the dataset's plain name at the zip
    /// root. Per issue #7 the `.sptb` body itself carries no folder info —
    /// the folder is encoded purely by the file's path inside the zip.
    pub fn export_tables_sptb_zip(
        &self,
        dataset_ids: &[String],
        archive_paths: &std::collections::HashMap<String, String>,
        output_path: &str,
    ) -> Result<(), AppError> {
        use std::io::Write;

        if dataset_ids.is_empty() {
            return Err(AppError::InvalidParam("没有可导出的数据表".to_string()));
        }
        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

        for id in dataset_ids {
            // Skip silently if the id no longer exists rather than aborting
            // the whole export — a half-stale UI list shouldn't lose the
            // rest of the bundle.
            let doc = match self.compose_table_doc(id) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let bytes = serde_json::to_vec_pretty(&doc)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            let raw = archive_paths.get(id).cloned().unwrap_or_else(|| doc.name.clone());
            let safe = sanitize_zip_path(&raw);
            let entry = dedupe_zip_path(&safe, "sptb", &mut used);
            zip.start_file(&entry, options)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
            zip.write_all(&bytes)
                .map_err(|e| AppError::FileIO(e.to_string()))?;
        }
        zip.finish().map_err(|e| AppError::FileIO(e.to_string()))?;
        Ok(())
    }

    /// Import a `.sptb` file from disk into the current project. Always
    /// allocates a fresh dataset id to avoid colliding with anything already
    /// loaded; returns the new id. Per issue #7 the `.sptb` body carries no
    /// folder info — the caller decides where to place the imported table
    /// (defaults to project root).
    pub fn import_table(&self, file_path: &str) -> Result<String, AppError> {
        let mut doc = spprj_archive::read_table_file(file_path)?;
        // Re-issue id to avoid collision with existing datasets in the project.
        let new_id = uuid::Uuid::new_v4().to_string();
        doc.id = new_id.clone();
        self.restore_table_doc(&doc)?;
        Ok(new_id)
    }

    /// Export an arbitrary graph builder config (opaque to backend) as a
    /// standalone `.spgh` file on disk. Per issue #7 the body is folder-free.
    pub fn export_graph(
        &self,
        graph: serde_json::Value,
        file_path: &str,
    ) -> Result<(), AppError> {
        let (id, name, body) = lift_graph_meta(graph);
        let doc = GraphDoc { id, name, version: "1".to_string(), body };
        spprj_archive::write_graph_file(&doc, file_path)
    }

    /// Read a `.spgh` file off disk and return its body as the same opaque
    /// JSON shape the frontend uses for graph_builders. `id` and `name` are
    /// re-injected into the body for frontend convenience; folder is NOT
    /// (the imported graph lands wherever the caller decides).
    pub fn import_graph(&self, file_path: &str) -> Result<serde_json::Value, AppError> {
        let doc = spprj_archive::read_graph_file(file_path)?;
        let mut body = doc.body;
        body.insert("id".to_string(), serde_json::Value::String(doc.id));
        if !doc.name.is_empty() {
            body.insert("name".to_string(), serde_json::Value::String(doc.name));
        }
        Ok(serde_json::Value::Object(body))
    }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

fn duckdb_to_json(value: duckdb::types::Value) -> serde_json::Value {
    match value {
        duckdb::types::Value::Null => serde_json::Value::Null,
        duckdb::types::Value::Boolean(b) => serde_json::Value::Bool(b),
        duckdb::types::Value::TinyInt(n) => serde_json::json!(n),
        duckdb::types::Value::SmallInt(n) => serde_json::json!(n),
        duckdb::types::Value::Int(n) => serde_json::json!(n),
        duckdb::types::Value::BigInt(n) => serde_json::json!(n),
        duckdb::types::Value::Float(f) => serde_json::json!(f),
        duckdb::types::Value::Double(f) => serde_json::json!(f),
        duckdb::types::Value::Text(s) => serde_json::Value::String(s),
        other => serde_json::Value::String(format!("{:?}", other)),
    }
}

/// Convert a list of opaque graph-builder JSON objects (frontend shape) into
/// `GraphDoc`s suitable for the archive. Ensures every doc has a stable id
/// and preserves the display name so the writer can place files at the right
/// paths inside the archive. Folder routing is handled OUT-OF-BAND via the
/// `graph_folders` map (issue #7) — any legacy in-body `folder` field is
/// silently stripped by `lift_graph_meta`.
fn compose_graph_docs(raw: Vec<serde_json::Value>) -> Vec<GraphDoc> {
    raw.into_iter().enumerate().map(|(idx, value)| {
        let (id, name, body) = lift_graph_meta(value);
        let id = if id.is_empty() { format!("graph_{}", idx) } else { id };
        GraphDoc { id, name, version: "1".to_string(), body }
    }).collect()
}

/// Pull `id` (or `builderId`) and `name` out of an opaque graph-builder
/// object. id / name / version / folder are *removed* from the returned body
/// so the GraphDoc that flattens it won't emit duplicate JSON keys on
/// serialization, and so legacy in-body folder hints can never override the
/// path-derived folder.
fn lift_graph_meta(
    raw: serde_json::Value,
) -> (String, String, serde_json::Map<String, serde_json::Value>) {
    let mut map = match raw {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    let id = map
        .remove("id")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| map.remove("builderId").and_then(|v| v.as_str().map(String::from)))
        .unwrap_or_default();
    let name = map
        .remove("name")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    map.remove("version");
    map.remove("folder"); // issue #7: folder lives only on archive paths.
    (id, name, map)
}

fn chrono_now() -> String {
    // Simple UTC timestamp without chrono dependency
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_default()
}

// Mark the bundle type as used: `ProjectBundle` is constructed exclusively via
// `spprj_archive::build_bundle` and consumed by `write_project_archive` /
// `read_project_file`, so it's referenced here only to silence dead-code
// analysis when the export commands are pruned by feature flags.
#[allow(dead_code)]
fn _bundle_compile_check(_b: ProjectBundle) {}

/// Sanitize a path destined for a ZIP archive. Forward slashes are kept as
/// folder separators; per-segment characters illegal on Windows are replaced
/// with `_`; leading/trailing dots and whitespace are trimmed per segment.
fn sanitize_zip_path(raw: &str) -> String {
    let parts: Vec<String> = raw
        .split('/')
        .map(|seg| {
            seg.replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                .trim()
                .trim_matches('.')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        "Untitled".to_string()
    } else {
        parts.join("/")
    }
}

/// Suffix `base.ext` with ` (2)`, ` (3)`, … until unique within `used`.
fn dedupe_zip_path(
    base: &str,
    ext: &str,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let mut candidate = format!("{}.{}", base, ext);
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{} ({}).{}", base, n, ext);
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}
