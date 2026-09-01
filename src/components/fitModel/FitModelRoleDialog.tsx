import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";

import { fitModelParameterCount } from "@/components/fitModel/fitModelConfig";
import { dataService } from "@/services/dataService";
import type { ColumnDisplayProps, DatasetMeta } from "@/types/data";

import {
  beginFitModelFieldLoad,
  FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
  canCreateFitModel,
  createAssignResponseAction,
  createFitModelSubmitCoordinator,
  createFitModelSubmitState,
  createFitModelDropAction,
  createFitModelDraft,
  createFitModelFieldLoadSnapshot,
  createToggleInteractionAction,
  createToggleMainEffectAction,
  filterFitModelFields,
  hasFitModelDragType,
  readFitModelDragPayload,
  reduceFitModelDraft,
  resolveFitModelFieldLoadError,
  resolveFitModelFieldLoadSuccess,
  termsFromDraft,
  toFitModelFieldInfo,
  type FitModelCreateDefinition,
  type FitModelDialogMessage,
  type FitModelFieldInfo,
} from "./fitModelDialogState";

export interface FitModelRoleDialogProps {
  dataset: DatasetMeta;
  onCreateDefinition: (definition: FitModelCreateDefinition) => void | Promise<void>;
  onCancel: () => void;
}

export function FitModelRoleDialog({ dataset, onCreateDefinition, onCancel }: FitModelRoleDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const validationId = `${titleId}-validation`;
  const [draft, setDraft] = useState(() => createFitModelDraft());
  const [loadSnapshot, setLoadSnapshot] = useState(() => createFitModelFieldLoadSnapshot());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [responseDragOver, setResponseDragOver] = useState(false);
  const [mainEffectsDragOver, setMainEffectsDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [submitState, setSubmitState] = useState(() => createFitModelSubmitState());
  const mountedRef = useRef(true);
  const onCreateDefinitionRef = useRef(onCreateDefinition);
  const submitCoordinatorRef = useRef(createFitModelSubmitCoordinator((definition) => onCreateDefinitionRef.current(definition)));

  const fields = loadSnapshot.fields;
  const loading = loadSnapshot.loading;
  const loadError = loadSnapshot.error;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    onCreateDefinitionRef.current = onCreateDefinition;
  }, [onCreateDefinition]);

  useEffect(() => {
    setDraft(createFitModelDraft());
    setSubmitState(createFitModelSubmitState());
  }, [dataset.id]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    setLoadSnapshot((current) => {
      const next = beginFitModelFieldLoad(current);
      generation = next.generation;
      return next;
    });

    Promise.all([
      dataService.getColumns(dataset.id),
      dataService.getColumnDisplayProps(dataset.id).catch(() => []),
    ])
      .then(([columns, displayProps]) => {
        if (!active) {
          return;
        }
        setLoadSnapshot((current) => resolveFitModelFieldLoadSuccess(
          current,
          generation,
          buildFitModelFieldInfoList(columns, displayProps),
        ));
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setLoadSnapshot((current) => resolveFitModelFieldLoadError(current, generation, reason));
      });

    return () => {
      active = false;
    };
  }, [dataset.id, retryGeneration]);

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
  const createDisabled = loading || submitState.creating || !canCreateFitModel(draft);
  const createErrorText = submitState.createError
    ? t("fitModel.dialog.createError", {
      defaultValue: "Failed to create Fit Model: {{message}}",
      message: submitState.createError,
    })
    : null;

  const assignedMainNames = new Set(draft.mainEffects.map((field) => field.name));
  const fieldsByName = useMemo(
    () => new Map(fields.map((field) => [field.name, field])),
    [fields],
  );
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

  const handleCreate = async () => {
    if (createDisabled || !draft.response) {
      return;
    }

    const definition: FitModelCreateDefinition = {
      response: { ...draft.response },
      terms,
      centeringMethod: draft.centeringMethod,
    };

    const submitPromise = submitCoordinatorRef.current.submit(definition);
    setSubmitState(submitCoordinatorRef.current.getState());
    await submitPromise;
    if (mountedRef.current) {
      setSubmitState(submitCoordinatorRef.current.getState());
    }
  };

  const handleDropAssignment = (zone: "response" | "mainEffects", event: DragEvent<HTMLElement>) => {
    const payload = readFitModelDragPayload(event.dataTransfer);
    setResponseDragOver(false);
    setMainEffectsDragOver(false);
    if (!payload) {
      return;
    }

    const action = createFitModelDropAction(zone, payload, fieldsByName);
    if (!action) {
      return;
    }

    event.preventDefault();
    setDraft((current) => reduceFitModelDraft(current, action));
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
                              setDraft((current) => reduceFitModelDraft(current, createAssignResponseAction(field)));
                            } else if (key === "m") {
                              event.preventDefault();
                              setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(field)));
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
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, createAssignResponseAction(field)))}
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
                              onClick={() => setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(field)))}
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
              <section
                className={`sp-tabulate-zone sp-fit-model-zone${responseDragOver ? " is-drop-target" : ""}`}
                aria-label={t("fitModel.dialog.response", { defaultValue: "Response" })}
                onDragOver={(event) => {
                  if (!hasFitModelDragType(event.dataTransfer.types)) {
                    return;
                  }
                  event.preventDefault();
                  setResponseDragOver(true);
                }}
                onDragLeave={() => setResponseDragOver(false)}
                onDrop={(event) => handleDropAssignment("response", event)}
              >
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
                        <span className="sp-tabulate-zone-hint">{t("fitModel.dialog.responseHint", { defaultValue: "Continuous" })}</span>
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

              <section
                className={`sp-tabulate-zone sp-fit-model-zone${mainEffectsDragOver ? " is-drop-target" : ""}`}
                aria-label={t("fitModel.dialog.mainEffects", { defaultValue: "Main Effects" })}
                onDragOver={(event) => {
                  if (!hasFitModelDragType(event.dataTransfer.types)) {
                    return;
                  }
                  event.preventDefault();
                  setMainEffectsDragOver(true);
                }}
                onDragLeave={() => setMainEffectsDragOver(false)}
                onDrop={(event) => handleDropAssignment("mainEffects", event)}
              >
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
                          onClick={() => setDraft((current) => reduceFitModelDraft(current, createToggleMainEffectAction(
                            fieldsByName.get(field.name) ?? {
                              name: field.name,
                              sqlType: "",
                              modelingRole: "Continuous",
                              field,
                            },
                          )))}
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
                          onClick={() => setDraft((current) => reduceFitModelDraft(
                            current,
                            createToggleInteractionAction(current, leftName, rightName),
                          ))}
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
                          <span className="sp-tabulate-zone-hint">
                            {term.kind === "main"
                              ? t("fitModel.dialog.termKindMain", { defaultValue: "Main" })
                              : t("fitModel.dialog.termKindInteraction", { defaultValue: "Interaction" })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          {loadError ? (
            <div className="sp-tabulate-inline-error" role="alert">
              <span>{loadError}</span>
              <button
                type="button"
                className="sp-tabulate-inline-button"
                onClick={() => setRetryGeneration((current) => current + 1)}
              >
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            </div>
          ) : null}
          {createErrorText ? <div className="sp-dialog-error" role="alert">{createErrorText}</div> : null}
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
