import { applyFactorialDegree, canonicalInteraction, fitModelParameterCount, validateFitModelDefinition } from "@/components/fitModel/fitModelConfig";
import { inferFieldType, type FieldRef } from "@/graphCore/types";
import type { ColumnDisplayProps } from "@/types/data";
import type { FitModelCenteringMethod, FitModelTerm } from "@/types/fitModel";

export const FIT_MODEL_DIALOG_FIELD_DRAG_MIME = "application/x-statsplayground-fit-model-field";

export interface FitModelDragPayload {
  fieldName: string;
}

export type FitModelDropZone = "response" | "mainEffects";

export interface FitModelFieldInfo {
  name: string;
  sqlType: string;
  modelingRole: "Continuous" | "Nominal" | "Ordinal" | "Datetime" | "Id";
  field: FieldRef;
}

export type FitModelDialogMessageCode =
  | "responseCollision"
  | "mainRequiredByInteraction"
  | "lastMainEffect"
  | "nonContinuousField"
  | "invalidInteraction";

export interface FitModelDialogMessage {
  code: FitModelDialogMessageCode;
  fieldName?: string;
  interactionLabels?: string[];
}

export interface FitModelDraft {
  response: FieldRef | null;
  mainEffects: FieldRef[];
  interactions: Array<[string, string]>;
  centeringMethod: FitModelCenteringMethod;
  validationMessage: FitModelDialogMessage | null;
}

export type FitModelDraftAction =
  | { type: "assignResponse"; field: FitModelFieldInfo }
  | { type: "clearResponse" }
  | { type: "toggleMainEffect"; field: FitModelFieldInfo }
  | { type: "addInteraction"; leftName: string; rightName: string }
  | { type: "removeInteraction"; leftName: string; rightName: string }
  | { type: "applyDegree"; degree: 1 | 2; fields: readonly FieldRef[] }
  | { type: "setCenteringMethod"; centeringMethod: FitModelCenteringMethod }
  | { type: "clearValidation" };

export interface FitModelFieldLoadSnapshot {
  generation: number;
  loading: boolean;
  error: string | null;
  fields: FitModelFieldInfo[];
}

export function createFitModelDraft(): FitModelDraft {
  return {
    response: null,
    mainEffects: [],
    interactions: [],
    centeringMethod: "none",
    validationMessage: null,
  };
}

export function createFitModelFieldLoadSnapshot(): FitModelFieldLoadSnapshot {
  return {
    generation: 0,
    loading: false,
    error: null,
    fields: [],
  };
}

export function beginFitModelFieldLoad(snapshot: FitModelFieldLoadSnapshot): FitModelFieldLoadSnapshot {
  return {
    ...snapshot,
    generation: snapshot.generation + 1,
    loading: true,
    error: null,
  };
}

export function resolveFitModelFieldLoadSuccess(
  snapshot: FitModelFieldLoadSnapshot,
  generation: number,
  fields: FitModelFieldInfo[],
): FitModelFieldLoadSnapshot {
  if (generation !== snapshot.generation) {
    return snapshot;
  }

  return {
    ...snapshot,
    loading: false,
    error: null,
    fields,
  };
}

export function resolveFitModelFieldLoadError(
  snapshot: FitModelFieldLoadSnapshot,
  generation: number,
  reason: unknown,
): FitModelFieldLoadSnapshot {
  if (generation !== snapshot.generation) {
    return snapshot;
  }

  return {
    ...snapshot,
    loading: false,
    error: String(reason),
    fields: [],
  };
}

export function createAssignResponseAction(field: FitModelFieldInfo): FitModelDraftAction {
  return {
    type: "assignResponse",
    field,
  };
}

export function createToggleMainEffectAction(field: FitModelFieldInfo): FitModelDraftAction {
  return {
    type: "toggleMainEffect",
    field,
  };
}

export function createToggleInteractionAction(
  draft: Pick<FitModelDraft, "interactions">,
  leftName: string,
  rightName: string,
): FitModelDraftAction {
  const [left, right] = canonicalInteraction(leftName, rightName);
  const exists = draft.interactions.some(([existingLeft, existingRight]) => (
    existingLeft === left && existingRight === right
  ));

  return exists
    ? { type: "removeInteraction", leftName: left, rightName: right }
    : { type: "addInteraction", leftName: left, rightName: right };
}

export function hasFitModelDragType(types: readonly string[]): boolean {
  return types.includes(FIT_MODEL_DIALOG_FIELD_DRAG_MIME);
}

export function parseFitModelDragPayload(raw: string): FitModelDragPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as FitModelDragPayload;
    if (payload && typeof payload === "object" && typeof payload.fieldName === "string") {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}

export function readFitModelDragPayload(dataTransfer: Pick<DataTransfer, "getData">): FitModelDragPayload | null {
  return parseFitModelDragPayload(dataTransfer.getData(FIT_MODEL_DIALOG_FIELD_DRAG_MIME));
}

export function createFitModelDropAction(
  zone: FitModelDropZone,
  payload: FitModelDragPayload,
  fieldsByName: ReadonlyMap<string, FitModelFieldInfo>,
): FitModelDraftAction | null {
  const field = fieldsByName.get(payload.fieldName);
  if (!field) {
    return null;
  }

  if (zone === "response") {
    return createAssignResponseAction(field);
  }

  return createToggleMainEffectAction(field);
}

export function toFitModelFieldInfo(
  name: string,
  sqlType: string,
  displayProps?: ColumnDisplayProps,
): FitModelFieldInfo {
  const role = inferFitModelFieldType(name, sqlType, displayProps);
  return {
    name,
    sqlType,
    modelingRole: toModelingRoleLabel(role),
    field: {
      name,
      type: role,
    },
  };
}

function inferFitModelFieldType(name: string, sqlType: string, displayProps?: ColumnDisplayProps): FieldRef["type"] {
  const extras = displayProps?.extras as { valueOrder?: { values?: unknown }; role?: unknown; semanticRole?: unknown } | undefined;
  if (Array.isArray(extras?.valueOrder?.values) && extras.valueOrder.values.length > 0) {
    return "ordinal";
  }

  const explicitRole = extras?.semanticRole ?? extras?.role;
  if (explicitRole === "continuous" || explicitRole === "nominal" || explicitRole === "ordinal" || explicitRole === "datetime" || explicitRole === "id") {
    return explicitRole;
  }

  if (name.toLowerCase() === "id" || name.toLowerCase().endsWith("_id")) {
    return "id";
  }

  return inferFieldType(sqlType);
}

function toModelingRoleLabel(role: FieldRef["type"]): FitModelFieldInfo["modelingRole"] {
  if (role === "continuous") return "Continuous";
  if (role === "ordinal") return "Ordinal";
  if (role === "datetime") return "Datetime";
  if (role === "id") return "Id";
  return "Nominal";
}

function cloneField(field: FieldRef): FieldRef {
  return { name: field.name, type: field.type };
}

function isContinuousField(field: FieldRef): boolean {
  return field.type === "continuous";
}

export function assignFitModelResponse(draft: FitModelDraft, fieldInfo: FitModelFieldInfo): FitModelDraft {
  const field = fieldInfo.field;
  if (!isContinuousField(field)) {
    return {
      ...draft,
      validationMessage: {
        code: "nonContinuousField",
        fieldName: field.name,
      },
    };
  }

  if (draft.mainEffects.some((entry) => entry.name === field.name)) {
    return {
      ...draft,
      validationMessage: {
        code: "responseCollision",
        fieldName: field.name,
      },
    };
  }

  return {
    ...draft,
    response: cloneField(field),
    validationMessage: null,
  };
}

function addMainEffect(draft: FitModelDraft, fieldInfo: FitModelFieldInfo): FitModelDraft {
  const field = fieldInfo.field;
  if (!isContinuousField(field)) {
    return {
      ...draft,
      validationMessage: {
        code: "nonContinuousField",
        fieldName: field.name,
      },
    };
  }

  if (draft.response?.name === field.name) {
    return {
      ...draft,
      validationMessage: {
        code: "responseCollision",
        fieldName: field.name,
      },
    };
  }

  return {
    ...draft,
    mainEffects: [...draft.mainEffects, cloneField(field)],
    validationMessage: null,
  };
}

function removeMainEffect(draft: FitModelDraft, fieldName: string): FitModelDraft {
  if (draft.mainEffects.length <= 1) {
    return {
      ...draft,
      validationMessage: {
        code: "lastMainEffect",
        fieldName,
      },
    };
  }

  const requiredBy = draft.interactions.filter(([leftName, rightName]) => (
    leftName === fieldName || rightName === fieldName
  ));
  if (requiredBy.length > 0) {
    return {
      ...draft,
      validationMessage: {
        code: "mainRequiredByInteraction",
        fieldName,
        interactionLabels: requiredBy.map(([leftName, rightName]) => `${leftName}*${rightName}`),
      },
    };
  }

  return {
    ...draft,
    mainEffects: draft.mainEffects.filter((field) => field.name !== fieldName),
    validationMessage: null,
  };
}

function addInteraction(draft: FitModelDraft, leftName: string, rightName: string): FitModelDraft {
  if (leftName === rightName) {
    return {
      ...draft,
      validationMessage: {
        code: "invalidInteraction",
      },
    };
  }

  const mainNames = new Set(draft.mainEffects.map((field) => field.name));
  if (!mainNames.has(leftName) || !mainNames.has(rightName)) {
    return {
      ...draft,
      validationMessage: {
        code: "invalidInteraction",
      },
    };
  }

  const nextInteraction = canonicalInteraction(leftName, rightName);
  if (draft.interactions.some(([left, right]) => left === nextInteraction[0] && right === nextInteraction[1])) {
    return {
      ...draft,
      validationMessage: null,
    };
  }

  return {
    ...draft,
    interactions: [...draft.interactions, nextInteraction],
    validationMessage: null,
  };
}

function removeInteraction(draft: FitModelDraft, leftName: string, rightName: string): FitModelDraft {
  const target = canonicalInteraction(leftName, rightName);
  const interactions = draft.interactions.filter(([left, right]) => !(left === target[0] && right === target[1]));
  const centeringMethod = interactions.length === 0 ? "none" : draft.centeringMethod;
  return {
    ...draft,
    interactions,
    centeringMethod,
    validationMessage: null,
  };
}

function applyDegreeMacro(draft: FitModelDraft, degree: 1 | 2, fields: readonly FieldRef[]): FitModelDraft {
  const predictors = fields.filter((field) => field.type === "continuous" && field.name !== draft.response?.name);
  const nextTerms = applyFactorialDegree(predictors, degree);
  const mainEffects = nextTerms
    .filter((term) => term.kind === "main")
    .map((term) => ({ name: term.columnNames[0], type: "continuous" as const }));
  const interactions: Array<[string, string]> = [];
  for (const term of nextTerms) {
    if (term.kind !== "interaction") {
      continue;
    }
    interactions.push(canonicalInteraction(term.columnNames[0], term.columnNames[1]));
  }

  return {
    ...draft,
    mainEffects,
    interactions,
    validationMessage: null,
  };
}

function setCenteringMethod(draft: FitModelDraft, centeringMethod: FitModelCenteringMethod): FitModelDraft {
  if (centeringMethod === "mean" && draft.interactions.length === 0) {
    return {
      ...draft,
      centeringMethod: "none",
      validationMessage: null,
    };
  }

  return {
    ...draft,
    centeringMethod,
    validationMessage: null,
  };
}

export function reduceFitModelDraft(draft: FitModelDraft, action: FitModelDraftAction): FitModelDraft {
  switch (action.type) {
    case "assignResponse":
      return assignFitModelResponse(draft, action.field);
    case "clearResponse":
      return {
        ...draft,
        response: null,
        validationMessage: null,
      };
    case "toggleMainEffect": {
      const exists = draft.mainEffects.some((field) => field.name === action.field.name);
      return exists ? removeMainEffect(draft, action.field.name) : addMainEffect(draft, action.field);
    }
    case "addInteraction":
      return addInteraction(draft, action.leftName, action.rightName);
    case "removeInteraction":
      return removeInteraction(draft, action.leftName, action.rightName);
    case "applyDegree":
      return applyDegreeMacro(draft, action.degree, action.fields);
    case "setCenteringMethod":
      return setCenteringMethod(draft, action.centeringMethod);
    case "clearValidation":
      return {
        ...draft,
        validationMessage: null,
      };
    default:
      return draft;
  }
}

export function termsFromDraft(draft: FitModelDraft): FitModelTerm[] {
  const terms: FitModelTerm[] = [];
  for (const field of draft.mainEffects) {
    terms.push({
      kind: "main",
      columnNames: [field.name],
    });
  }
  for (const [leftName, rightName] of draft.interactions) {
    terms.push({
      kind: "interaction",
      columnNames: canonicalInteraction(leftName, rightName),
    });
  }
  return terms;
}

export function canCreateFitModel(draft: FitModelDraft): boolean {
  if (!draft.response) {
    return false;
  }

  const terms = termsFromDraft(draft);
  if (terms.length === 0) {
    return false;
  }

  if (draft.centeringMethod === "mean" && draft.interactions.length === 0) {
    return false;
  }

  const validation = validateFitModelDefinition({
    response: draft.response,
    terms,
    fields: [draft.response, ...draft.mainEffects],
  });

  return validation.ok && fitModelParameterCount(terms) >= 2;
}

export function filterFitModelFields(fields: readonly FitModelFieldInfo[], query: string): FitModelFieldInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...fields];
  }

  return fields.filter(({ name, sqlType, modelingRole }) => {
    const haystack = `${name} ${sqlType} ${modelingRole}`.toLowerCase();
    return haystack.includes(needle);
  });
}
