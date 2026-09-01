import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFitModelStore } from "@/stores/useFitModelStore";
import type { DatasetMeta } from "@/types/data";
import type { FitModelCenteringMethod, FitModelItem, FitModelTerm } from "@/types/fitModel";

import { FitModelReport } from "./FitModelReport";
import { removeFitModelTerm } from "./fitModelReportModel";
import { useFitModelReport } from "./useFitModelReport";

interface FitModelUndoSnapshot {
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
}

export interface FitModelViewProps {
  item: FitModelItem;
  dataset: DatasetMeta | undefined;
}

function cloneTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => ({
    kind: term.kind,
    columnNames: [...term.columnNames],
  }));
}

export function FitModelView({ item, dataset }: FitModelViewProps) {
  const { t } = useTranslation();
  const updateDefinition = useFitModelStore((state) => state.updateDefinition);
  const [undoSnapshot, setUndoSnapshot] = useState<FitModelUndoSnapshot | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);

  const reportState = useFitModelReport(dataset ? item : null, dataset?.updatedAt ?? null);

  const termCount = useMemo(() => item.terms.length, [item.terms]);

  const handleRemoveTerm = (termId: string) => {
    const removal = removeFitModelTerm(item.terms, termId);

    if (!removal.ok) {
      const key = `fitModel.report.removeBlocked.${removal.reason}`;
      const localized = t(key);
      setRemoveMessage(localized === key ? removal.reason : localized);
      return;
    }

    setRemoveMessage(null);
    setUndoSnapshot({
      terms: cloneTerms(removal.undoSnapshot.terms),
      centeringMethod: item.centeringMethod,
    });
    updateDefinition(item.id, {
      terms: removal.nextTerms,
      centeringMethod: item.centeringMethod,
    });
  };

  const handleUndo = () => {
    if (!undoSnapshot) {
      return;
    }

    updateDefinition(item.id, {
      terms: undoSnapshot.terms,
      centeringMethod: undoSnapshot.centeringMethod,
    });
    setUndoSnapshot(null);
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
        removeMessage={removeMessage}
        onRemoveTerm={handleRemoveTerm}
        onUndoRemove={undoSnapshot ? handleUndo : null}
      />
    </div>
  );
}
