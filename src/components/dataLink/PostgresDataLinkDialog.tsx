import { useState } from "react";
import { useTranslation } from "react-i18next";

import { dataLinkService } from "@/services/dataLinkService";
import type {
  ConnectionCredentials,
  ConnectionDefinition,
  DataLinkError,
  PreviewResult,
  SourceColumn,
  SourceObjectRef,
} from "@/types/dataLink";

import "./dataLink.css";

interface PostgresDataLinkDialogProps {
  onClose: () => void;
  onImported: (targetName: string) => Promise<void>;
}

const DEFAULT_DEFINITION: ConnectionDefinition = {
  connector: "postgresql",
  host: "127.0.0.1",
  port: 55432,
  database: "statsplayground_test",
  authenticationType: "usernamePassword",
  tlsMode: "disabled",
  connectTimeoutSeconds: 10,
};

function displayValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function normalizeError(error: unknown): DataLinkError {
  if (typeof error === "string") {
    return { category: "storage", message: error };
  }
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    const candidate = error as Partial<DataLinkError>;
    if (typeof candidate.category === "string" && typeof candidate.message === "string") {
      return candidate as DataLinkError;
    }
  }
  return { category: "query", message: "PostgreSQL operation could not be completed" };
}

export function PostgresDataLinkDialog({ onClose, onImported }: PostgresDataLinkDialogProps) {
  const { t } = useTranslation();
  const [definition, setDefinition] = useState(DEFAULT_DEFINITION);
  const [credentials, setCredentials] = useState<ConnectionCredentials>({
    username: "stats_reader",
    password: "",
  });
  const [connected, setConnected] = useState(false);
  const [objects, setObjects] = useState<SourceObjectRef[]>([]);
  const [selectedObject, setSelectedObject] = useState<SourceObjectRef | null>(null);
  const [columns, setColumns] = useState<SourceColumn[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [targetName, setTargetName] = useState("");
  const [busy, setBusy] = useState<"connection" | "objects" | "preview" | "import" | null>(null);
  const [error, setError] = useState<DataLinkError | null>(null);

  const setDefinitionField = <K extends keyof ConnectionDefinition>(
    key: K,
    value: ConnectionDefinition[K],
  ) => {
    setDefinition((current) => ({ ...current, [key]: value }));
    setConnected(false);
    setObjects([]);
    setSelectedObject(null);
    setColumns([]);
    setPreview(null);
    setTargetName("");
    setError(null);
  };

  const setCredentialField = <K extends keyof ConnectionCredentials>(
    key: K,
    value: ConnectionCredentials[K],
  ) => {
    setCredentials((current) => ({ ...current, [key]: value }));
    setConnected(false);
    setObjects([]);
    setSelectedObject(null);
    setColumns([]);
    setPreview(null);
    setTargetName("");
    setError(null);
  };

  const testConnection = async () => {
    setBusy("connection");
    setError(null);
    try {
      await dataLinkService.testPostgresConnection(definition, credentials);
      setConnected(true);
    } catch (connectionError) {
      setConnected(false);
      setError(normalizeError(connectionError));
    } finally {
      setBusy(null);
    }
  };

  const discoverObjects = async () => {
    setBusy("objects");
    setError(null);
    try {
      const discovered = await dataLinkService.listPostgresObjects(definition, credentials);
      setObjects(discovered);
      if (discovered.length > 0) await selectObject(discovered[0]);
    } catch (discoveryError) {
      setError(normalizeError(discoveryError));
    } finally {
      setBusy(null);
    }
  };

  const selectObject = async (object: SourceObjectRef) => {
    setSelectedObject(object);
    setTargetName(object.name);
    setColumns([]);
    setPreview(null);
    setBusy("preview");
    setError(null);
    try {
      const [nextColumns, nextPreview] = await Promise.all([
        dataLinkService.getPostgresSchema(definition, credentials, object),
        dataLinkService.previewPostgresObject(definition, credentials, object),
      ]);
      setColumns(nextColumns);
      setPreview(nextPreview);
    } catch (previewError) {
      setError(normalizeError(previewError));
    } finally {
      setBusy(null);
    }
  };

  const importSnapshot = async () => {
    if (!selectedObject || !targetName.trim()) return;
    setBusy("import");
    setError(null);
    try {
      await dataLinkService.importPostgresSnapshot(
        definition,
        credentials,
        selectedObject,
        targetName.trim(),
      );
      await onImported(targetName.trim());
      onClose();
    } catch (importError) {
      setError(normalizeError(importError));
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  return (
    <div className="sp-dialog-overlay datalink-overlay" onMouseDown={isBusy ? undefined : onClose}>
      <div className="sp-dialog datalink-dialog postgres-datalink-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="datalink-header">
          <div>
            <h2>{t("postgresDataLink.title", { defaultValue: "PostgreSQL DataLink" })}</h2>
            <p>{connected
              ? `${definition.host}:${definition.port} / ${definition.database}`
              : t("postgresDataLink.sessionOnly", { defaultValue: "Credentials remain in this dialog only" })}</p>
          </div>
          <button className="datalink-close" onClick={onClose} title={t("common.cancel")} aria-label={t("common.cancel")} disabled={isBusy}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="postgres-datalink-body">
          <section className="postgres-connection-panel" aria-label={t("postgresDataLink.connection", { defaultValue: "Connection" })}>
            <div className="datalink-section-title">
              {t("postgresDataLink.connection", { defaultValue: "Connection" })}
              <span className={connected ? "is-connected" : ""}>{connected
                ? t("postgresDataLink.connected", { defaultValue: "Connected" })
                : t("postgresDataLink.notTested", { defaultValue: "Not tested" })}</span>
            </div>
            <div className="postgres-connection-grid">
              <label>
                <span>{t("postgresDataLink.host", { defaultValue: "Host" })}</span>
                <input value={definition.host} onChange={(event) => setDefinitionField("host", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.port", { defaultValue: "Port" })}</span>
                <input type="number" min={1} max={65535} value={definition.port} onChange={(event) => setDefinitionField("port", Number(event.target.value))} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.database", { defaultValue: "Database" })}</span>
                <input value={definition.database} onChange={(event) => setDefinitionField("database", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.username", { defaultValue: "Username" })}</span>
                <input value={credentials.username} autoComplete="username" onChange={(event) => setCredentialField("username", event.target.value)} disabled={isBusy} />
              </label>
              <label className="postgres-password-field">
                <span>{t("postgresDataLink.password", { defaultValue: "Password" })}</span>
                <input type="password" value={credentials.password} autoComplete="current-password" onChange={(event) => setCredentialField("password", event.target.value)} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.timeout", { defaultValue: "Timeout (seconds)" })}</span>
                <input type="number" min={1} max={300} value={definition.connectTimeoutSeconds} onChange={(event) => setDefinitionField("connectTimeoutSeconds", Number(event.target.value))} disabled={isBusy} />
              </label>
              <label>
                <span>{t("postgresDataLink.tlsMode", { defaultValue: "TLS mode" })}</span>
                <select value={definition.tlsMode} onChange={(event) => setDefinitionField("tlsMode", event.target.value as ConnectionDefinition["tlsMode"])} disabled={isBusy}>
                  <option value="disabled">{t("postgresDataLink.tlsDisabled", { defaultValue: "Disabled" })}</option>
                  <option value="required">{t("postgresDataLink.tlsRequired", { defaultValue: "Required" })}</option>
                  <option value="verifyCa">{t("postgresDataLink.tlsVerifyCa", { defaultValue: "Verify CA" })}</option>
                  <option value="verifyFull">{t("postgresDataLink.tlsVerifyFull", { defaultValue: "Verify full" })}</option>
                </select>
              </label>
            </div>
            <div className="postgres-connection-actions">
              <span><i className="fa-solid fa-shield-halved" aria-hidden="true" /> {t("postgresDataLink.credentialsNote", { defaultValue: "Password is discarded when this dialog closes" })}</span>
              <button className="btn-text" onClick={() => void testConnection()} disabled={isBusy || !credentials.password}>
                {busy === "connection"
                  ? t("postgresDataLink.testing", { defaultValue: "Testing..." })
                  : t("postgresDataLink.test", { defaultValue: "Test connection" })}
              </button>
              <button className="btn-primary" onClick={() => void discoverObjects()} disabled={isBusy || !connected}>
                {busy === "objects"
                  ? t("postgresDataLink.discovering", { defaultValue: "Discovering..." })
                  : t("postgresDataLink.discover", { defaultValue: "Discover objects" })}
              </button>
            </div>
          </section>

          {error && (
            <div className="datalink-error postgres-error" role="alert">
              <strong>{error.category}</strong>
              <span>{error.message}</span>
            </div>
          )}

          <div className="datalink-content postgres-browser">
            <aside className="datalink-objects">
              <div className="datalink-section-title">
                {t("dataLink.objects", { defaultValue: "Objects" })}
                <span>{objects.length}</span>
              </div>
              {objects.length === 0 ? (
                <div className="datalink-state">{connected
                  ? t("postgresDataLink.discoverPrompt", { defaultValue: "Discover accessible tables and views" })
                  : t("postgresDataLink.connectPrompt", { defaultValue: "Test the connection first" })}</div>
              ) : objects.map((object) => {
                const key = `${object.catalog}.${object.schema}.${object.name}`;
                const isActive = selectedObject?.catalog === object.catalog
                  && selectedObject?.schema === object.schema
                  && selectedObject?.name === object.name;
                return (
                  <div key={key} className={`datalink-object postgres-object${isActive ? " active" : ""}`}>
                    <i className={`fa-solid ${object.objectType === "view" ? "fa-eye" : "fa-table"}`} aria-hidden="true" />
                    <button className="datalink-object-preview" onClick={() => void selectObject(object)} disabled={isBusy}>
                      <span>{object.name}</span>
                      <small>{object.schema}</small>
                    </button>
                  </div>
                );
              })}
            </aside>

            <main className="datalink-preview">
              {busy === "preview" ? (
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
                  <div className="datalink-schema">
                    {columns.map((column) => (
                      <span key={column.name} title={`${column.sourceType}${column.nullable ? "" : " NOT NULL"}`}>
                        <strong>{column.name}</strong>
                        <small>{column.sourceType}{column.precision !== null ? `(${column.precision}${column.scale !== null ? `,${column.scale}` : ""})` : ""}{column.primaryKey ? " · PK" : ""}</small>
                      </span>
                    ))}
                  </div>
                  <label className="datalink-target-name">
                    <span>{t("dataLink.targetName", { defaultValue: "Target dataset name" })}</span>
                    <input
                      value={targetName}
                      onChange={(event) => setTargetName(event.target.value)}
                      disabled={isBusy}
                    />
                  </label>
                  <div className="datalink-table-wrap">
                    <table className="datalink-table">
                      <thead><tr>{preview.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead>
                      <tbody>{preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>{row.map((value, columnIndex) => (
                          <td key={columnIndex} className={value === null ? "is-null" : ""}>{displayValue(value)}</td>
                        ))}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="datalink-state">{t("dataLink.selectObject", { defaultValue: "Select an object to preview" })}</div>
              )}
            </main>
          </div>
        </div>

        <footer className="datalink-actions">
          <span>{t("postgresDataLink.snapshotNote", { defaultValue: "Imports a snapshot into the current workspace" })}</span>
          <button className="btn-text" onClick={onClose} disabled={isBusy}>{t("common.cancel")}</button>
          <button
            className="btn-primary"
            onClick={() => void importSnapshot()}
            disabled={isBusy || !selectedObject || !targetName.trim()}
          >
            {busy === "import"
              ? t("postgresDataLink.importing", { defaultValue: "Importing..." })
              : t("postgresDataLink.importSnapshot", { defaultValue: "Import snapshot" })}
          </button>
        </footer>
      </div>
    </div>
  );
}
