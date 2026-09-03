import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { dataLinkService } from "@/services/dataLinkService";
import type { PreviewResult, SourceObject, SqliteImportSelection } from "@/types/dataLink";

import "./dataLink.css";

interface SqliteDataLinkDialogProps {
  filePath: string;
  existingDatasetNames: string[];
  onClose: () => void;
  onImport: (selections: SqliteImportSelection[]) => Promise<void>;
}

type ConflictStrategy = "rename" | "append" | "skip";

function displayValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function uniqueTargetName(sourceName: string, reservedNames: Set<string>): string {
  if (!reservedNames.has(sourceName.toLowerCase())) return sourceName;
  let suffix = 2;
  while (reservedNames.has(`${sourceName} (${suffix})`.toLowerCase())) suffix += 1;
  return `${sourceName} (${suffix})`;
}

export function SqliteDataLinkDialog({
    filePath,
    existingDatasetNames,
    onClose,
    onImport,
  }: SqliteDataLinkDialogProps) {
  const { t } = useTranslation();
  const [objects, setObjects] = useState<SourceObject[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>("rename");
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [targetNames, setTargetNames] = useState<Record<string, string>>({});
  const fileName = filePath.split(/[\\/]/).pop() ?? "SQLite";
  const existingNames = new Set(existingDatasetNames.map((name) => name.toLowerCase()));
  const tableObjects = objects.filter((object) => object.objectType === "table");
  const conflictCount = tableObjects.filter((object) => existingNames.has(object.name.toLowerCase())).length;

  const applyConflictStrategy = (strategy: ConflictStrategy, nextObjects = objects) => {
    const tables = nextObjects.filter((object) => object.objectType === "table");
    const reserved = new Set(existingNames);
    const nextSelected = new Set<string>();
    const nextTargets: Record<string, string> = {};
    for (const table of tables) {
      const conflicts = existingNames.has(table.name.toLowerCase());
      if (strategy === "skip" && conflicts) continue;
      const targetName = strategy === "rename"
        ? uniqueTargetName(table.name, reserved)
        : table.name;
      nextSelected.add(table.name);
      nextTargets[table.name] = targetName;
      reserved.add(targetName.toLowerCase());
    }
    setConflictStrategy(strategy);
    setSelectedTables(nextSelected);
    setTargetNames(nextTargets);
  };

  useEffect(() => {
    let active = true;
    setLoadingObjects(true);
    dataLinkService.listSqliteObjects(filePath)
      .then((nextObjects) => {
        if (!active) return;
        setObjects(nextObjects);
        setSelectedName(nextObjects[0]?.name ?? null);
        applyConflictStrategy("rename", nextObjects);
      })
      .catch((cause) => active && setError(String(cause)))
      .finally(() => active && setLoadingObjects(false));
    return () => { active = false; };
  }, [filePath]);

  useEffect(() => {
    if (!selectedName) {
      setPreview(null);
      return;
    }
    let active = true;
    setLoadingPreview(true);
    setPreview(null);
    setError(null);
    dataLinkService.previewSqliteObject(filePath, selectedName)
      .then((result) => active && setPreview(result))
      .catch((cause) => active && setError(String(cause)))
      .finally(() => active && setLoadingPreview(false));
    return () => { active = false; };
  }, [filePath, selectedName]);

  const handleImport = async () => {
    const selections = tableObjects
      .filter((object) => selectedTables.has(object.name))
      .map((object) => ({
        sourceName: object.name,
        targetName: targetNames[object.name]?.trim() ?? "",
        action: conflictStrategy === "append" && existingNames.has(object.name.toLowerCase())
          ? "append" as const
          : "create" as const,
      }));
    const createdTargets = selections
      .filter((selection) => selection.action === "create")
      .map((selection) => selection.targetName.toLowerCase());
    if (selections.some((selection) => !selection.targetName)) {
      setError(t("dataLink.targetRequired", { defaultValue: "Target names cannot be empty." }));
      return;
    }
    if (new Set(createdTargets).size !== createdTargets.length) {
      setError(t("dataLink.duplicateTarget", { defaultValue: "Target names must be unique." }));
      return;
    }
    if (createdTargets.some((name) => existingNames.has(name))) {
      setError(t("dataLink.targetExists", { defaultValue: "A selected target name already exists." }));
      return;
    }
    setImporting(true);
    setError(null);
    try {
      await onImport(selections);
      onClose();
    } catch (cause) {
      setError(String(cause));
      setImporting(false);
    }
  };

  return (
    <div className="sp-dialog-overlay datalink-overlay" onMouseDown={importing ? undefined : onClose}>
      <div className="sp-dialog datalink-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="datalink-header">
          <div>
            <h2>{t("dataLink.title", { defaultValue: "SQLite DataLink" })}</h2>
            <p>{fileName}</p>
          </div>
          <button className="datalink-close" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")} disabled={importing}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="datalink-content">
          <aside className="datalink-objects">
            <div className="datalink-section-title">
              {t("dataLink.objects", { defaultValue: "Objects" })}
              <span>{objects.length}</span>
            </div>
            {loadingObjects ? (
              <div className="datalink-state">{t("common.loading")}</div>
            ) : objects.length === 0 ? (
              <div className="datalink-state">{t("dataLink.noObjects", { defaultValue: "No tables or views" })}</div>
            ) : objects.map((object) => {
              const selected = selectedTables.has(object.name);
              const conflicts = existingNames.has(object.name.toLowerCase());
              return (
                <div
                  key={object.name}
                  className={`datalink-object${selectedName === object.name ? " active" : ""}`}
                >
                  {object.objectType === "table" ? (
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        const next = new Set(selectedTables);
                        if (event.target.checked) {
                          next.add(object.name);
                          if (!targetNames[object.name]) {
                            const reserved = new Set([...existingNames, ...Object.values(targetNames).map((name) => name.toLowerCase())]);
                            setTargetNames({ ...targetNames, [object.name]: uniqueTargetName(object.name, reserved) });
                          }
                        } else {
                          next.delete(object.name);
                        }
                        setSelectedTables(next);
                      }}
                      aria-label={t("dataLink.selectTable", { name: object.name, defaultValue: "Select {{name}}" })}
                    />
                  ) : <i className="fa-solid fa-eye" aria-hidden="true" />}
                  <button className="datalink-object-preview" onClick={() => setSelectedName(object.name)}>
                    <span>{object.name}{conflicts && <em>{t("dataLink.exists", { defaultValue: "Exists" })}</em>}</span>
                    <small>{object.columns.length}</small>
                  </button>
                </div>
              );
            })}
          </aside>

          <main className="datalink-preview">
            {error && <div className="datalink-error">{error}</div>}
            {conflictCount > 0 && (
              <div className="datalink-conflicts">
                <strong>{t("dataLink.conflictsFound", { count: conflictCount, defaultValue: "{{count}} name conflicts" })}</strong>
                <div className="datalink-strategy" role="group" aria-label={t("dataLink.conflictStrategy", { defaultValue: "Conflict strategy" })}>
                  <button className={conflictStrategy === "rename" ? "active" : ""} onClick={() => applyConflictStrategy("rename")}>
                    {t("dataLink.keepBoth", { defaultValue: "Keep both" })}
                  </button>
                  <button className={conflictStrategy === "append" ? "active" : ""} onClick={() => applyConflictStrategy("append")}>
                    {t("dataLink.appendRows", { defaultValue: "Append rows" })}
                  </button>
                  <button className={conflictStrategy === "skip" ? "active" : ""} onClick={() => applyConflictStrategy("skip")}>
                    {t("dataLink.skipExisting", { defaultValue: "Skip existing" })}
                  </button>
                </div>
              </div>
            )}
            {loadingPreview ? (
              <div className="datalink-state">{t("dataLink.loadingPreview", { defaultValue: "Loading preview..." })}</div>
            ) : preview ? (
              <>
                <div className="datalink-preview-heading">
                  <div>
                    <h3>{preview.objectName}</h3>
                    <span>{t("dataLink.previewRows", { count: preview.rows.length, defaultValue: "{{count}} preview rows" })}</span>
                  </div>
                  {preview.truncated && <span>{t("dataLink.limited", { defaultValue: "Limited to 100 rows" })}</span>}
                </div>
                <div className="datalink-type-policy">
                  <i className="fa-solid fa-circle-info" aria-hidden="true" />
                  <span>{t("dataLink.typePolicy")}</span>
                </div>
                {selectedTables.has(preview.objectName) && (
                  <label className="datalink-target-name">
                    <span>{t("dataLink.targetName", { defaultValue: "Target dataset name" })}</span>
                    <input
                      value={targetNames[preview.objectName] ?? ""}
                      onChange={(event) => setTargetNames({ ...targetNames, [preview.objectName]: event.target.value })}
                      disabled={importing || (conflictStrategy === "append" && existingNames.has(preview.objectName.toLowerCase()))}
                    />
                    {conflictStrategy === "append" && existingNames.has(preview.objectName.toLowerCase()) && (
                      <small>{t("dataLink.appendRequiresMatch", { defaultValue: "Column names, order, and types must match." })}</small>
                    )}
                  </label>
                )}
                <div className="datalink-schema">
                  {preview.columns.map((column) => (
                    <span key={column.name} title={`${column.sourceType}${column.nullable ? "" : " NOT NULL"}`}>
                      <strong>{column.name}</strong>
                      <small>{column.sourceType || "ANY"}{column.primaryKey ? " · PK" : ""}</small>
                    </span>
                  ))}
                </div>
                <div className="datalink-table-wrap">
                  <table className="datalink-table">
                    <thead><tr>{preview.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((value, columnIndex) => (
                            <td key={columnIndex} className={value === null ? "is-null" : ""}>{displayValue(value)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : !loadingObjects && <div className="datalink-state">{t("dataLink.selectObject", { defaultValue: "Select an object to preview" })}</div>}
          </main>
        </div>

        <footer className="datalink-actions">
          <span>{t("dataLink.selectedCount", { count: selectedTables.size, defaultValue: "{{count}} tables selected" })}</span>
          <button className="btn-text" onClick={onClose} disabled={importing}>{t("common.cancel")}</button>
          <button className="btn-primary" onClick={handleImport} disabled={loadingObjects || selectedTables.size === 0 || importing}>
            {importing
              ? t("dataLink.importing", { defaultValue: "Importing..." })
              : t("dataLink.importSelected", { defaultValue: "Import selected" })}
          </button>
        </footer>
      </div>
    </div>
  );
}
