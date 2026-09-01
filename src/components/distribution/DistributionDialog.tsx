import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
  DistributionColumnRefV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

import {
  createDefaultDistributionVisualDiagnosticsConfig,
  createDefaultDistributionContinuousFitConfig,
  DISTRIBUTION_CAPABILITY_OVERRIDE_REGISTRY,
  NORMAL_CAPABILITY_ID,
  normalizeDistributionAnalysisConfig,
  validateDistributionConfig,
} from "./distributionConfig";
import { DistributionRoleZone } from "./DistributionRoleZone";
import { SpecificationLimitsEditor } from "./SpecificationLimitsEditor";

interface DistributionDialogProps {
  open: boolean;
  datasetId: string;
  columns: DistributionColumnInfoV1[];
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  initialConfig?: DistributionAnalysisConfigV1;
  recallConfig?: DistributionAnalysisConfigV1;
  datasets?: Array<{ id: string; name: string }>;
  onDatasetChange?: (datasetId: string) => void | Promise<void>;
  onSave: (config: DistributionAnalysisConfigV1) => void | Promise<void>;
  onRun: (config: DistributionAnalysisConfigV1) => void | Promise<void>;
  onCancel: () => void;
}

function createDefaultConfig(
  datasetId: string,
  bootstrap?: DistributionWorkspaceBootstrapV1 | null,
): DistributionAnalysisConfigV1 {
  return {
    schemaVersion: "1",
    sourceDatasetId: datasetId,
    yColumns: [],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "and", exprs: [] },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    continuousFit: createDefaultDistributionContinuousFitConfig(),
    visualDiagnostics: createDefaultDistributionVisualDiagnosticsConfig(),
    enabledCapabilityIds: bootstrap?.capabilities.some(
      (capability) => capability.id === NORMAL_CAPABILITY_ID,
    ) ? [NORMAL_CAPABILITY_ID] : [],
    capabilityOverrides: [],
  };
}

function toColumnRef(column: DistributionColumnInfoV1): DistributionColumnRefV1 {
  return { columnId: column.columnId, modelingType: column.modelingType };
}

function isNumericColumn(column: DistributionColumnInfoV1): boolean {
  return column.modelingType === "continuous" || column.modelingType === "discreteNumeric";
}

function displayName(column: DistributionColumnInfoV1): string {
  return column.name || column.columnId;
}

export function DistributionDialog({
  open,
  datasetId,
  columns,
  bootstrap,
  initialConfig,
  recallConfig,
  datasets = [],
  onDatasetChange,
  onSave,
  onRun,
  onCancel,
}: DistributionDialogProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<DistributionAnalysisConfigV1>(() =>
    normalizeDistributionAnalysisConfig(structuredClone(initialConfig ?? createDefaultConfig(datasetId, bootstrap))),
  );
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const next = normalizeDistributionAnalysisConfig(
        structuredClone(initialConfig ?? createDefaultConfig(datasetId, bootstrap)),
      );
      if (bootstrap?.capabilities.some((capability) => capability.id === NORMAL_CAPABILITY_ID) &&
          !next.enabledCapabilityIds.includes(NORMAL_CAPABILITY_ID)) {
        next.enabledCapabilityIds.push(NORMAL_CAPABILITY_ID);
      }
      setConfig(next);
      setSearch("");
    }
  }, [bootstrap, datasetId, initialConfig, open]);

  if (!open) return null;

  const columnById = new Map(columns.map((column) => [column.columnId, column]));
  const displayNameById = new Map(columns.map((column) => [column.columnId, displayName(column)]));
  const refsFor = (columnIds: string[]) => columnIds.flatMap((columnId) => {
    const column = columnById.get(columnId);
    return column ? [toColumnRef(column)] : [];
  });
  const filteredColumns = columns.filter((column) =>
    displayName(column).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const validationErrors = validateDistributionConfig(
    config,
    columns,
    DISTRIBUTION_CAPABILITY_OVERRIDE_REGISTRY,
  );
  const valid = validationErrors.length === 0;
  const canRun = valid && bootstrap?.canRun === true && bootstrap.capabilities.length > 0;

  const addMultiRole = (role: "yColumns" | "byColumnIds", column: DistributionColumnInfoV1) => {
    setConfig((current) => role === "yColumns"
      ? current.yColumns.some((item) => item.columnId === column.columnId)
        ? current
        : { ...current, yColumns: [...current.yColumns, toColumnRef(column)] }
      : current.byColumnIds.includes(column.columnId)
        ? current
        : { ...current, byColumnIds: [...current.byColumnIds, column.columnId] });
  };

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave(structuredClone(config));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog distribution-dialog" role="dialog" aria-label={t("distribution.title")} onClick={(event) => event.stopPropagation()}>
        <header className="distribution-dialog-header">
          <h3>{t("distribution.title")}</h3>
          <button type="button" className="btn-text" data-testid="distribution-recall" onClick={() => setConfig(normalizeDistributionAnalysisConfig(structuredClone(recallConfig ?? initialConfig ?? createDefaultConfig(datasetId))))}>
            {t("distribution.recall")}
          </button>
        </header>

        <div className="distribution-dialog-scroll">
          <div className="distribution-dialog-body">
          <aside className="distribution-column-browser">
            {datasets.length > 0 && (
              <label className="distribution-dataset-field">
                <span>{t("distribution.sourceDataset", { defaultValue: "Source dataset" })}</span>
                <select
                  value={datasetId}
                  onChange={(event) => void onDatasetChange?.(event.target.value)}
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label htmlFor="distribution-column-search">{t("distribution.searchColumns")}</label>
            <input
              id="distribution-column-search"
              data-testid="distribution-column-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="distribution-column-list">
              {filteredColumns.map((column) => (
                <div
                  className="distribution-column-row"
                  data-testid={`distribution-column-${column.columnId}`}
                  draggable
                  key={column.columnId}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-statsplayground-distribution", column.columnId);
                    event.dataTransfer.setData("text/plain", column.columnId);
                  }}
                >
                  <span title={displayName(column)}>{displayName(column)}</span>
                  <div className="distribution-column-actions">
                    <button type="button" data-testid={`distribution-assign-y-${column.columnId}`} aria-label={t("distribution.assignToRole", { column: column.columnId, role: "Y" })} disabled={column.modelingType !== "continuous"} onClick={() => addMultiRole("yColumns", column)}>Y</button>
                    <button type="button" data-testid={`distribution-assign-weight-${column.columnId}`} aria-label={t("distribution.assignToRole", { column: column.columnId, role: t("distribution.roles.weight") })} disabled={!isNumericColumn(column)} onClick={() => setConfig((current) => ({ ...current, weightColumnId: column.columnId }))}>{t("distribution.roles.weight")}</button>
                    <button type="button" data-testid={`distribution-assign-frequency-${column.columnId}`} aria-label={t("distribution.assignToRole", { column: column.columnId, role: t("distribution.roles.frequency") })} disabled={!column.integerCompatible} onClick={() => setConfig((current) => ({ ...current, frequencyColumnId: column.columnId }))}>{t("distribution.frequencyShort")}</button>
                    <button type="button" data-testid={`distribution-assign-by-${column.columnId}`} aria-label={t("distribution.assignToRole", { column: column.columnId, role: t("distribution.roles.by") })} onClick={() => addMultiRole("byColumnIds", column)}>By</button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <main className="distribution-role-grid">
            <DistributionRoleZone role="Y" columns={config.yColumns} displayNameById={displayNameById} onAssign={(columnId) => { const column = columnById.get(columnId); if (column?.modelingType === "continuous") addMultiRole("yColumns", column); }} onRemove={(columnId) => setConfig((current) => ({ ...current, yColumns: current.yColumns.filter((column) => column.columnId !== columnId) }))} />
            <DistributionRoleZone role="Weight" columns={config.weightColumnId ? refsFor([config.weightColumnId]) : []} displayNameById={displayNameById} onAssign={(columnId) => { const column = columnById.get(columnId); if (column && isNumericColumn(column)) setConfig((current) => ({ ...current, weightColumnId: columnId })); }} onRemove={() => setConfig((current) => ({ ...current, weightColumnId: null }))} />
            <DistributionRoleZone role="Frequency" columns={config.frequencyColumnId ? refsFor([config.frequencyColumnId]) : []} displayNameById={displayNameById} onAssign={(columnId) => { const column = columnById.get(columnId); if (column?.integerCompatible) setConfig((current) => ({ ...current, frequencyColumnId: columnId })); }} onRemove={() => setConfig((current) => ({ ...current, frequencyColumnId: null }))} />
            <DistributionRoleZone role="By" columns={refsFor(config.byColumnIds)} displayNameById={displayNameById} onAssign={(columnId) => { const column = columnById.get(columnId); if (column) addMultiRole("byColumnIds", column); }} onRemove={(columnId) => setConfig((current) => ({ ...current, byColumnIds: current.byColumnIds.filter((id) => id !== columnId) }))} />
          </main>
          </div>

          <div className="distribution-options">
            <label className="distribution-option">
              <span>{t("distribution.confidenceLevel")}</span>
              <input data-testid="distribution-confidence-level" type="number" min="0.01" max="0.99" step="0.01" value={config.confidenceLevel} onChange={(event) => setConfig((current) => ({ ...current, confidenceLevel: Number(event.target.value) }))} />
            </label>
            <label className="distribution-option distribution-option-checkbox">
              <input type="checkbox" checked={config.histogramsOnly} onChange={(event) => setConfig((current) => ({ ...current, histogramsOnly: event.target.checked }))} />
              <span>{t("distribution.histogramsOnly")}</span>
            </label>
          </div>

          {bootstrap?.capabilities.some((capability) => capability.id === NORMAL_CAPABILITY_ID) && (
            <SpecificationLimitsEditor
              override={config.capabilityOverrides.find(
                (override) => override.capabilityId === NORMAL_CAPABILITY_ID,
              ) ?? null}
              yCount={config.yColumns.length}
              onChange={(nextOverride) => setConfig((current) => ({
                ...current,
                enabledCapabilityIds: current.enabledCapabilityIds.includes(NORMAL_CAPABILITY_ID)
                  ? current.enabledCapabilityIds
                  : [...current.enabledCapabilityIds, NORMAL_CAPABILITY_ID],
                capabilityOverrides: [
                  ...current.capabilityOverrides.filter(
                    (override) => override.capabilityId !== NORMAL_CAPABILITY_ID,
                  ),
                  ...(nextOverride ? [nextOverride] : []),
                ],
              }))}
            />
          )}

          {!canRun && (
            <p className="distribution-run-hint" data-testid="distribution-run-disabled-hint">
              {!valid ? t("distribution.invalidConfig") : t("distribution.runDisabledHint")}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn-primary" data-testid="distribution-save" disabled={!valid || saving} onClick={handleSave}>{saving ? t("distribution.saving") : t("common.save")}</button>
          <button type="button" data-testid="distribution-run" disabled={!canRun} onClick={() => void onRun(structuredClone(config))}>{t("distribution.run")}</button>
          <button type="button" className="btn-text" data-testid="distribution-cancel" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}