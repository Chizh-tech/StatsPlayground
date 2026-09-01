export {
  FitModelReport,
  type FitModelReportProps,
} from "./FitModelReport";

export {
  buildEffectSummary,
  fitModelTermId,
  formatFitModelReportPValue,
  formatFitModelReportValue,
  logWorth,
  removeFitModelTerm,
  type FitModelEffectRow,
  type FitModelRemoveResult,
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
