import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { GraphRuntime } from "@/components/graphBuilder/GraphRuntime";
import type { DatasetMeta } from "@/types/data";
import type { FitYByXItem } from "@/types/fitYByX";

export interface FitYByXViewProps {
  item: FitYByXItem;
  dataset: DatasetMeta | undefined;
}

export function FitYByXView({ item, dataset }: FitYByXViewProps) {
  const { t } = useTranslation();

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

  if (dataset == null) {
    return (
      <div className="sp-fit-y-by-x-view">
        <section className="sp-fit-y-by-x-summary">
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-header-hint">{t("workspace.datasourceDeleted", { defaultValue: "Source unavailable" })}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-body">
            <div className="sp-fit-y-by-x-summary-row">
              <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.response", { defaultValue: "Response (Y)" })}</span>
              <span className="sp-fit-y-by-x-summary-value">{item.response.name}</span>
            </div>
            <div className="sp-fit-y-by-x-summary-row">
              <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.factor", { defaultValue: "Factor (X)" })}</span>
              <span className="sp-fit-y-by-x-summary-value">{item.factor.name}</span>
            </div>
          </div>
        </section>

        <section className="sp-fit-y-by-x-runtime-panel">
          <div className="sp-tabulate-state-card" role="status" aria-live="polite">
            <div className="sp-tabulate-state-title">
              {t("tabulate.sourceUnavailableTitle", { defaultValue: "Source unavailable" })}
            </div>
            <div className="sp-tabulate-state-detail">
              {t("tabulate.sourceUnavailableDetail", {
                defaultValue: "The source dataset for this analysis is no longer available.",
              })}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="sp-fit-y-by-x-view">
      <section className="sp-fit-y-by-x-summary">
        <div className="sp-panel-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-source-label" title={dataset.name}>
              {t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })}
            </span>
          </div>
        </div>

        <div className="sp-fit-y-by-x-summary-body">
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.response", { defaultValue: "Response (Y)" })}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.response.name}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.factor", { defaultValue: "Factor (X)" })}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.factor.name}</span>
          </div>
        </div>
      </section>

      <section className="sp-fit-y-by-x-runtime-panel">
        <div className="sp-panel-header">
          <span className="sp-panel-header-title">{t("fitYByX.graph", { defaultValue: "Graph" })}</span>
          <span className="sp-tabulate-header-hint">{t("fitYByX.graphHint", { defaultValue: "Embedded runtime" })}</span>
        </div>

        <div className="sp-fit-y-by-x-runtime-shell">
          <GraphRuntime
            item={graphItem}
            dataset={dataset}
          />
        </div>
      </section>
    </div>
  );
}