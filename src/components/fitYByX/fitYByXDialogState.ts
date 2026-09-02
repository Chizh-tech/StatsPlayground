import type { FieldRef } from "@/graphCore/types";
import type { FitYByXConstructModelEffects } from "@/types/fitYByX";

import {
  DEFAULT_CONSTRUCT_MODEL_EFFECTS,
  DEFAULT_FACTORIAL_DEGREE,
  normalizeConstructModelEffects,
  deriveFitYByXPersonality,
} from "./fitYByXModel";

import {
  canAssignFitYByXRole,
  type FitYByXRole,
  type FitYByXValidationError,
  validateFitYByXRoles,
} from "./fitYByXRoles";

export interface FitYByXFieldInfo {
  name: string;
  sqlType: string;
  modelingRole: "Continuous" | "Nominal" | "Ordinal" | "Datetime";
  field: FieldRef;
}

export interface FitYByXDialogState {
  name: string;
  response?: FieldRef;
  factor?: FieldRef;
  constructModelEffects: FitYByXConstructModelEffects;
  factorialDegree: number;
  validationError: FitYByXValidationError | null;
}

export function createFitYByXDialogState(defaultName: string): FitYByXDialogState {
  return {
    name: defaultName,
    constructModelEffects: DEFAULT_CONSTRUCT_MODEL_EFFECTS,
    factorialDegree: DEFAULT_FACTORIAL_DEGREE,
    validationError: null,
  };
}

export function assignFitYByXField(
  state: FitYByXDialogState,
  role: FitYByXRole,
  field: FitYByXFieldInfo,
): FitYByXDialogState {
  const other = role === "response" ? state.factor : state.response;
  const validation = canAssignFitYByXRole(role, field.field, other);
  if (validation !== true) {
    return {
      ...state,
      validationError: validation,
    };
  }

  const next = {
    ...state,
    [role]: { ...field.field },
    validationError: null,
  };
  return syncConstructModelEffects(next);
}

function syncConstructModelEffects(state: FitYByXDialogState): FitYByXDialogState {
  const personality = state.factor ? deriveFitYByXPersonality(state.factor) : undefined;
  if (!personality) {
    return state;
  }
  const normalized = normalizeConstructModelEffects({
    personality,
    constructModelEffects: state.constructModelEffects,
    factorialDegree: state.factorialDegree,
  });
  return {
    ...state,
    constructModelEffects: normalized.constructModelEffects ?? DEFAULT_CONSTRUCT_MODEL_EFFECTS,
    factorialDegree: normalized.factorialDegree ?? DEFAULT_FACTORIAL_DEGREE,
  };
}

export function setConstructModelEffects(
  state: FitYByXDialogState,
  constructModelEffects: FitYByXConstructModelEffects,
): FitYByXDialogState {
  return syncConstructModelEffects({
    ...state,
    constructModelEffects,
  });
}

export function setFactorialDegree(
  state: FitYByXDialogState,
  factorialDegree: number,
): FitYByXDialogState {
  return syncConstructModelEffects({
    ...state,
    factorialDegree,
  });
}

export function clearFitYByXField(state: FitYByXDialogState, role: FitYByXRole): FitYByXDialogState {
  return syncConstructModelEffects({
    ...state,
    [role]: undefined,
    validationError: null,
  });
}

export function filterFitYByXFields(fields: readonly FitYByXFieldInfo[], query: string): FitYByXFieldInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...fields];
  }

  return fields.filter(({ name, sqlType, modelingRole }) => {
    const haystack = `${name} ${sqlType} ${modelingRole}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function canCreateFitYByX(state: FitYByXDialogState): boolean {
  return state.name.trim().length > 0 && validateFitYByXRoles({
    response: state.response,
    factor: state.factor,
  }).ok;
}