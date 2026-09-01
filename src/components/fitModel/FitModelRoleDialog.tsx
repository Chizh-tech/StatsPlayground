import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { fitModelParameterCount } from "@/components/fitModel/fitModelConfig";
import type { FieldRef } from "@/graphCore/types";
import { dataService } from "@/services/dataService";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";
import type { FitModelCenteringMethod, FitModelTerm } from "@/types/fitModel";

import {
  FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
  canCreateFitModel,
  createFitModelDraft,
  filterFitModelFields,
  reduceFitModelDraft,
  termsFromDraft,
  toFitModelFieldInfo,
  type FitModelDialogMessage,
  type FitModelFieldInfo,
} from "./fitModelDialogState";

export interface FitModelRoleDialogProps {
  dataset: DatasetMeta;
  onCreateDefinition: (definition: {
    response: FieldRef;
    terms: FitModelTerm[];
    centeringMethod: FitModelCenteringMethod;
  }) => void;
  onCancel: () => void;
}

export function FitModelRoleDialog({ dataset, onCreateDefinition, onCancel }: FitModelRoleDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const validationId = `${titleId}-validation`;
  const [draft, setDraft] = useState(() => createFitModelDraft());
  const [fields, setFields] = useState<FitModelFieldInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setDraft(createFitModelDraft());
  }, [dataset.id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    Promise.all([
      dataService.getColumns(dataset.id),
      dataService.getColumnDisplayProps(dataset.id).catch(() => []),
    ])
      .then(([columns, displayProps]) => {
        if (!active) {
          return;
        }
        setFields(buildFitModelFieldInfoList(columns, displayProps));
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setFields([]);
        setLoading(false);
        setLoadError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [dataset.id]);

  const visibleFields = useMemo(
    () => filterFitModelFields(fields, search),
    [fields, search],
  );

  const allFieldRefs = useMemo(
    () => fields.map((field) => field.field),
    [fields],
  );

  const terms = useMemo(() => termsFromDraft(draft), [draft]);
  const parameterCount = useMemo(() => fitModelParameterCount(terms), [terms]);
  const validationText = useMemo(() => toValidationText(draft.validationMessage, t), [draft.validationMessage, t]);
  const createDisabled = loading || !canCreateFitModel(draft);

  const assignedMainNames = new Set(draft.mainEffects.map((field) => field.name));
  const interactionSet = new Set(draft.interactions.map(([leftName, rightName]) => `${leftName}*${rightName}`));
  const interactionOptions = useMemo(() => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < draft.mainEffects.length; i += 1) {
      for (let j = i + 1; j < draft.mainEffects.length; j += 1) {
        const left = draft.mainEffects[i].name;
        const right = draft.mainEffects[j].name;
        pairs.push(left.localeCompare(right) <= 0 ? [left, right] : [right, left]);
      }
    }
    return pairs;
  }, [draft.mainEffects]);

  const handleCreate = () => {
    if (createDisabled || !draft.response) {
      return;
    }

    onCreateDefinition({
      response: { ...draft.response },
      terms,
      centeringMethod: draft.centeringMethod,
    });
  };

  return (
    <div className="sp-dialog-overlay" onMouseDown={onCancel}>
      <div
        className="sp-dialog sp-dialog-wide sp-fit-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={validationText ? validationId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sp-dialog-title" id={titleId}>
          {t("fitModel.dialog.title", { defaultValue: "Fit Model" })}
        </div>

        <div className="sp-dialog-body sp-fit-model-dialog-body">
          <div className="sp-fit-model-dialog-grid">
            <section className="sp-tabulate-panel sp-fit-model-fields-panel" aria-label={t("fitModel.dialog.availableFields", { defaultValue: "Available fields" })}>
              <div className="sp-panel-header">
                <div className="sp-tabulate-heading-copy">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.availableFields", { defaultValue: "Available fields" })}</span>
                  <span className="sp-tabulate-source-label" title={dataset.name}>
                    {t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })}
                  </span>
                </div>
              </div>

              <div className="sp-tabulate-field-toolbar">
                <label className="sp-tabulate-search" aria-label={t("fitModel.dialog.searchFields", { defaultValue: "Search fields" })}>
                  <i className="fa-solid fa-magnifying-glass" aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("fitModel.dialog.searchFields", { defaultValue: "Search fields" })}
                    aria-label={t("fitModel.dialog.searchAvailableFields", { defaultValue: "Search available fields" })}
                  />
                </label>
              </div>

              <div className="sp-cols-panel-list" role="list" aria-busy={loading}>
                {loading ? <div className="sp-tabulate-empty-note">{t("fitModel.dialog.loadingFields", { defaultValue: "Loading fields…" })}</div> : null}
                {!loading && visibleFields.length === 0 ? (
                  <div className="sp-tabulate-empty-note">
                    {fields.length === 0
                      ? t("fitModel.dialog.noFields", { defaultValue: "No fields available for this source." })
                      : t("fitModel.dialog.noMatch", { defaultValue: "No fields match the current search." })}
                  </div>
                ) : null}
                {!loading
                  ? visibleFields.map((field) => {
                      const assignedResponse = draft.response?.name === field.name;
                      const assignedMain = assignedMainNames.has(field.name);
                      const assigned = assignedResponse || assignedMain;
                      const continuous = field.field.type === "continuous";
                      return (
                        <div
                          key={field.name}
                          role="listitem"
                          tabIndex={0}
                          draggable
                          className={`sp-cols-panel-item sp-fit-model-field${assigned ? " sp-cols-panel-item-selected" : ""}`}
                          title={`${field.name} (${field.sqlType}, ${field.modelingRole})`}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "copyMove";
                            event.dataTransfer.setData(
                              FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
                              JSON.stringify({ fieldName: field.name }),
                            );
                          }}
                          onKeyDown={(event) => {
                            const key = event.key.toLowerCase();
                            if (key === "y") {
                              event.preventDefault();
                              setDraft((current) => reduceFitModelDraft(current, {
                                type: "assignResponse",
                                field,
                              }));
                            } else if (key === "m") {
                              event.preventDefault();
                              setDraft((current) => reduceFitModelDraft(current, {
                                type: "toggleMainEffect",
                                field,
                              }));
                            }
                          }}
                        >
                          <div className="sp-fit-model-field-copy">
                            <span className="sp-cols-panel-item-type">{field.sqlType}</span>
                            <span className="sp-cols-panel-item-name">{field.name}</span>
                            <span className="sp-cols-panel-item-extras">{field.modelingRole}</span>
                          </div>

                          <div className="sp-fit-model-field-actions">
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                                type: "assignResponse",
                                field,
                              }))}
                              disabled={!continuous}
                              aria-label={t("fitModel.dialog.assignResponseLabel", {
                                defaultValue: "Assign {{field}} as response",
                                field: field.name,
                              })}
                              title={t("fitModel.dialog.assignResponse", { defaultValue: "Assign as Y" })}
                            >
                              Y
                            </button>
                            <button
                              type="button"
                              className="sp-tabulate-inline-button"
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                                type: "toggleMainEffect",
                                field,
                              }))}
                              disabled={!continuous}
                              aria-label={t("fitModel.dialog.assignMainLabel", {
                                defaultValue: "Toggle {{field}} as main effect",
                                field: field.name,
                              })}
                              title={t("fitModel.dialog.assignMain", { defaultValue: "Toggle Main" })}
                            >
                              M
                            </button>
                          </div>
                        </div>
                      );
                    })
                  : null}
              </div>
            </section>

            <div className="sp-fit-model-roles-column">
              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.response", { defaultValue: "Response" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.response", { defaultValue: "Y, Response" })}</span>
                  <span className="sp-tabulate-header-hint">{t("fitModel.dialog.continuousOnly", { defaultValue: "Continuous" })}</span>
                </div>
                <div className="sp-tabulate-zone-body" role="list">
                  {!draft.response ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.responseEmpty", { defaultValue: "Drop or assign one continuous response field." })}</div>
                  ) : (
                    <div role="listitem" className="sp-tabulate-zone-item">
                      <div className="sp-tabulate-zone-copy">
                        <span className="sp-tabulate-zone-label">{draft.response.name}</span>
                        <span className="sp-tabulate-zone-hint">continuous</span>
                      </div>
                      <div className="sp-tabulate-zone-actions">
                        <button
                          type="button"
                          className="sp-tabulate-inline-button"
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, { type: "clearResponse" }))}
                          aria-label={t("fitModel.dialog.clearResponse", {
                            defaultValue: "Clear response {{field}}",
                            field: draft.response.name,
                          })}
                        >
                          <i className="fa-solid fa-xmark" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.mainEffects", { defaultValue: "Main Effects" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.mainEffects", { defaultValue: "Main Effects" })}</span>
                  <span className="sp-tabulate-header-hint">{t("fitModel.dialog.continuousOnly", { defaultValue: "Continuous" })}</span>
                </div>
                <div className="sp-tabulate-zone-body" role="list">
                  {draft.mainEffects.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.mainEffectsEmpty", { defaultValue: "Select one or more continuous predictors." })}</div>
                  ) : draft.mainEffects.map((field) => (
                    <div key={field.name} role="listitem" className="sp-tabulate-zone-item">
                      <div className="sp-tabulate-zone-copy">
                        <span className="sp-tabulate-zone-label">{field.name}</span>
                      </div>
                      <div className="sp-tabulate-zone-actions">
                        <button
                          type="button"
                          className="sp-tabulate-inline-button"
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                            type: "toggleMainEffect",
                            field: {
                              name: field.name,
                              sqlType: "",
                              modelingRole: "Continuous",
                              field,
                            },
                          }))}
                          aria-label={t("fitModel.dialog.removeMainEffect", {
                            defaultValue: "Remove main effect {{field}}",
                            field: field.name,
                          })}
                        >
                          <i className="fa-solid fa-xmark" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.interactions", { defaultValue: "Interactions" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.interactions", { defaultValue: "Interactions" })}</span>
                  <span className="sp-tabulate-header-hint">{t("fitModel.dialog.twoWayOnly", { defaultValue: "Two-way" })}</span>
                </div>

                <div className="sp-tabulate-zone-body" role="list">
                  {draft.interactions.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.interactionsEmpty", { defaultValue: "Add two-way interactions from selected main effects." })}</div>
                  ) : draft.interactions.map(([leftName, rightName]) => (
                    <div key={`${leftName}*${rightName}`} role="listitem" className="sp-tabulate-zone-item">
                      <div className="sp-tabulate-zone-copy">
                        <span className="sp-tabulate-zone-label">{`${leftName}*${rightName}`}</span>
                      </div>
                      <div className="sp-tabulate-zone-actions">
                        <button
                          type="button"
                          className="sp-tabulate-inline-button"
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                            type: "removeInteraction",
                            leftName,
                            rightName,
                          }))}
                          aria-label={t("fitModel.dialog.removeInteraction", {
                            defaultValue: "Remove interaction {{term}}",
                            term: `${leftName}*${rightName}`,
                          })}
                        >
                          <i className="fa-solid fa-xmark" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {interactionOptions.length > 0 ? (
                  <div className="sp-fit-model-interaction-builder" aria-label={t("fitModel.dialog.addInteraction", { defaultValue: "Add interaction" })}>
                    {interactionOptions.map(([leftName, rightName]) => {
                      const termLabel = `${leftName}*${rightName}`;
                      const selected = interactionSet.has(termLabel);
                      return (
                        <button
                          key={termLabel}
                          type="button"
                          className={`sp-tabulate-inline-button${selected ? " sp-tabulate-inline-button-selected" : ""}`}
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                            type: "addInteraction",
                            leftName,
                            rightName,
                          }))}
                          aria-pressed={selected}
                          aria-label={t("fitModel.dialog.toggleInteraction", {
                            defaultValue: "Toggle interaction {{term}}",
                            term: termLabel,
                          })}
                        >
                          {termLabel}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.macros", { defaultValue: "Macros" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.macros", { defaultValue: "Macros" })}</span>
                </div>
                <div className="sp-fit-model-macro-actions">
                  <button
                    type="button"
                    className="sp-dialog-btn"
                    onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                      type: "applyDegree",
                      degree: 1,
                      fields: allFieldRefs,
                    }))}
                  >
                    {t("fitModel.dialog.degree1", { defaultValue: "Degree 1" })}
                  </button>
                  <button
                    type="button"
                    className="sp-dialog-btn"
                    onClick={() => setDraft((current) => reduceFitModelDraft(current, {
                      type: "applyDegree",
                      degree: 2,
                      fields: allFieldRefs,
                    }))}
                  >
                    {t("fitModel.dialog.degree2", { defaultValue: "Degree 2" })}
                  </button>
                </div>

                <label className="sp-fit-model-centering-toggle">
                  <input
                    type="checkbox"
                    checked={draft.centeringMethod === "mean"}
                    disabled={draft.interactions.length === 0}
                    onChange={(event) => setDraft((current) => reduceFitModelDraft(current, {
                      type: "setCenteringMethod",
                      centeringMethod: event.target.checked ? "mean" : "none",
                    }))}
                  />
                  {t("fitModel.dialog.centerInteractions", { defaultValue: "Center Interactions" })}
                </label>
              </section>

              <section className="sp-tabulate-zone sp-fit-model-zone" aria-label={t("fitModel.dialog.currentTerms", { defaultValue: "Current Model Terms" })}>
                <div className="sp-panel-header">
                  <span className="sp-panel-header-title">{t("fitModel.dialog.currentTerms", { defaultValue: "Current Model Terms" })}</span>
                  <span className="sp-tabulate-header-hint">
                    {t("fitModel.dialog.parameterCount", {
                      defaultValue: "Parameters: {{count}}",
                      count: parameterCount,
                    })}
                  </span>
                </div>
                <div className="sp-tabulate-zone-body" role="list">
                  {terms.length === 0 ? (
                    <div className="sp-tabulate-empty-note">{t("fitModel.dialog.termsEmpty", { defaultValue: "No model terms selected." })}</div>
                  ) : terms.map((term) => {
                    const termLabel = term.kind === "main" ? term.columnNames[0] : `${term.columnNames[0]}*${term.columnNames[1]}`;
                    return (
                      <div key={`${term.kind}:${termLabel}`} role="listitem" className="sp-tabulate-zone-item">
                        <div className="sp-tabulate-zone-copy">
                          <span className="sp-tabulate-zone-label">{termLabel}</span>
                          <span className="sp-tabulate-zone-hint">{term.kind === "main" ? "main" : "interaction"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          {loadError ? <div className="sp-tabulate-inline-error">{loadError}</div> : null}
          {validationText ? <div id={validationId} className="sp-dialog-error" role="alert">{validationText}</div> : null}
        </div>

        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-dialog-btn sp-dialog-btn-primary"
            onClick={handleCreate}
            disabled={createDisabled}
          >
            {t("fitModel.dialog.create", { defaultValue: "Create" })}
          </button>
          <button type="button" className="sp-dialog-btn" onClick={onCancel}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildFitModelFieldInfoList(
  columns: ReadonlyArray<readonly [string, string]>,
  displayProps: readonly ColumnDisplayProps[],
): FitModelFieldInfo[] {
  const propsByIndex = new Map(displayProps.map((entry) => [entry.colIndex, entry]));
  return columns.map(([name, sqlType], index) => toFitModelFieldInfo(name, sqlType, propsByIndex.get(index)));
}

function toValidationText(
  message: FitModelDialogMessage | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!message) {
    return null;
  }

  if (message.code === "responseCollision") {
    return t("fitModel.dialog.validation.responseCollision", {
      defaultValue: "Response column cannot also be a model term.",
    });
  }

  if (message.code === "mainRequiredByInteraction") {
    return t("fitModel.dialog.validation.mainRequiredByInteraction", {
      defaultValue: "Remove interactions first: {{terms}}",
      terms: (message.interactionLabels ?? []).join(", "),
    });
  }

  if (message.code === "lastMainEffect") {
    return t("fitModel.dialog.validation.lastMainEffect", {
      defaultValue: "Model requires at least one main effect.",
    });
  }

  if (message.code === "nonContinuousField") {
    return t("fitModel.dialog.validation.nonContinuousField", {
      defaultValue: "Only continuous fields are available for response and model terms.",
    });
  }

  return t("fitModel.dialog.validation.invalidInteraction", {
    defaultValue: "Interaction must reference two different selected main effects.",
  });
}
