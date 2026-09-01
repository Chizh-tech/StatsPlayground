export {
  FitModelReport,
  type FitModelReportProps,
} from "./FitModelReport";

export {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  buildEffectSummary,
  createFitModelDefinitionConfig,
  fitModelTermId,
  formatFitModelReportPValue,
  formatFitModelReportValue,
  logWorth,
  removeFitModelTerm,
  type FitModelDefinitionConfig,
  type FitModelEffectRow,
  type FitModelRemoveResult,
  type FitModelRemoveTransitionResult,
  type FitModelUndoSnapshot,
  type FitModelUndoTransitionResult,
} from "./fitModelReportModel";

export {
  FitModelView,
  type FitModelViewProps,
} from "./FitModelView";

export {
  useFitModelReport,
  createFitModelReportController,
  type FitModelReportState,
} from "./useFitModelReport";

export {
  applyFactorialDegree,
  canonicalInteraction,
  canonicalizeFitModelTerms,
  createFitModelItem,
  fitModelParameterCount,
  FitModelValidationError,
  validateFitModelDefinition,
} from "./fitModelConfig";
