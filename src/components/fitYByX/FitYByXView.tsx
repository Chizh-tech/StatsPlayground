import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { GraphRuntime } from "@/components/graphBuilder/GraphRuntime";
import type { DatasetMeta } from "@/types/data";
import type { FitYByXItem } from "@/types/fitYByX";

import { FitYByXReport } from "./FitYByXReport";
import { useFitYByXReport } from "./useFitYByXReport";

export interface FitYByXViewProps {
  item: FitYByXItem;
  dataset: DatasetMeta | undefined;
}

export function FitYByXView({ item, dataset }: FitYByXViewProps) {
  const { t } = useTranslation();
  const reportState = useFitYByXReport(dataset ? item : null, dataset?.updatedAt ?? null);

  const graphItem = useMemo(
    () => createEmbeddedGraphItem({
      id: `fit-y-by-x-graph:${item.id}`,
      name: item.name,
      sourceDatasetId: item.sourceDatasetId,
      config: item.graph,
      createdAt: item.createdAt,
    }),
    [item],
  );

  return (
    <div className="sp-fit-y-by-x-view">
      <section className="sp-fit-y-by-x-summary">
        <div className="sp-panel-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-source-label" title={dataset ? dataset.name : t("workspace.datasourceDeleted")}>
              {dataset
                ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
                : t("workspace.datasourceDeleted")}
            </span>
          </div>
        </div>

        <div className="sp-fit-y-by-x-summary-body">
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.response")}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.response.name}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.factor")}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.factor.name}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.personalityLabel")}</span>
            <span className="sp-fit-y-by-x-summary-value">{t(`fitYByX.personality.${item.personality}`)}</span>
          </div>
        </div>
      </section>

      <div className="sp-fit-y-by-x-analysis-root">
        <section className="sp-fit-y-by-x-runtime-panel">
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("fitYByX.graph")}</span>
            <span className="sp-tabulate-header-hint">{t("fitYByX.graphHint")}</span>
          </div>

          <div className="sp-fit-y-by-x-graph-shell">
            {dataset == null ? (
              <div className="main-content">
                <div className="workspace-empty">
                  <p>{t("workspace.datasourceDeleted")}</p>
                </div>
              </div>
            ) : (
              <GraphRuntime
                item={graphItem}
                dataset={dataset}
              />
            )}
          </div>
        </section>

        <FitYByXReport item={item} state={reportState} datasetMissing={dataset == null} />
      </div>
    </div>
  );
}