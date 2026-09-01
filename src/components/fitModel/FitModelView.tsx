import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFitModelStore } from "@/stores/useFitModelStore";
import type { DatasetMeta } from "@/types/data";
import type { FitModelItem } from "@/types/fitModel";

import { FitModelReport } from "./FitModelReport";
import {
  applyFitModelTermRemoval,
  applyFitModelTermUndo,
  createFitModelDefinitionConfig,
  type FitModelUndoSnapshot,
} from "./fitModelReportModel";
import { useFitModelReport } from "./useFitModelReport";

export interface FitModelViewProps {
  item: FitModelItem;
  dataset: DatasetMeta | undefined;
}

export function FitModelView({ item, dataset }: FitModelViewProps) {
  const { t } = useTranslation();
  const updateDefinition = useFitModelStore((state) => state.updateDefinition);
  const [undoSnapshot, setUndoSnapshot] = useState<FitModelUndoSnapshot | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);

  const reportState = useFitModelReport(dataset && !item.loadIssue ? item : null, dataset?.updatedAt ?? null);

  const definition = useMemo(() => createFitModelDefinitionConfig({
    terms: item.terms,
    centeringMethod: item.centeringMethod,
  }), [item.centeringMethod, item.terms]);

  const termCount = useMemo(() => item.terms.length, [item.terms]);

  const handleRemoveTerm = (termId: string) => {
    const removal = applyFitModelTermRemoval(definition, termId, undoSnapshot);

    if (!removal.ok) {
      const key = `fitModel.report.removeBlocked.${removal.reason}`;
      const localized = t(key);
      setRemoveMessage(localized === key ? removal.reason : localized);
      return;
    }

    setRemoveMessage(null);
    setUndoSnapshot(removal.undoSnapshot);
    updateDefinition(item.id, removal.nextDefinition);
  };

  const handleUndo = () => {
    const undo = applyFitModelTermUndo(definition, undoSnapshot);

    if (!undo.restored) {
      return;
    }

    updateDefinition(item.id, undo.nextDefinition);
    setUndoSnapshot(undo.nextUndoSnapshot);
    setRemoveMessage(null);
  };

  return (
    <div className="sp-fit-model-view">
      <section className="sp-fit-model-summary">
        <div className="sp-panel-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-source-label" title={dataset ? dataset.name : t("workspace.datasourceDeleted") }>
              {dataset
                ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
                : t("workspace.datasourceDeleted")}
            </span>
          </div>
        </div>

        <div className="sp-fit-model-summary-body">
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.response", { defaultValue: "Y, Response" })}</span>
            <span className="sp-fit-model-summary-value">{item.response.name}</span>
          </div>
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.modelTermCount", { defaultValue: "Model terms" })}</span>
            <span className="sp-fit-model-summary-value">{termCount}</span>
          </div>
          <div className="sp-fit-model-summary-row">
            <span className="sp-fit-model-summary-label">{t("fitModel.centeringMethod", { defaultValue: "Centering" })}</span>
            <span className="sp-fit-model-summary-value">
              {t(`fitModel.centering.${item.centeringMethod}`, { defaultValue: item.centeringMethod })}
            </span>
          </div>
        </div>
      </section>

      <FitModelReport
        item={item}
        state={reportState}
        datasetMissing={dataset == null}
        loadIssue={item.loadIssue ?? null}
        removeMessage={removeMessage}
        onRemoveTerm={handleRemoveTerm}
        onUndoRemove={undoSnapshot ? handleUndo : null}
      />
    </div>
  );
}
