import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DistributionContinuousFitConfigV1,
  ContinuousDistributionIdV1,
  DistributionGroupResultV1,
  DistributionGroupValueV1,
  DistributionReportBlockV1,
  DistributionYReportPreferencesV1,
  DistributionYResultV1,
} from "@/types/distribution";
import { DISTRIBUTION_FIT_CAPABILITY_REGISTRY } from "./distributionConfig";

import {
  DistributionChart,
  DistributionFitDensityChart,
  DistributionOverviewChart,
} from "./DistributionChart";
import { ContinuousFitComparisonReport, ContinuousFitReport } from "./ContinuousFitReport";
import { ProcessCapabilityReport } from "./ProcessCapabilityReport";
import { StemAndLeafReport } from "./StemAndLeafReport";

interface DistributionReportProps {
  groups: DistributionGroupResultV1[];
  histogramMethod?:
    | "jmpAuto"
    | "freedmanDiaconis"
    | "scott"
    | "sturges"
    | "fixedCount"
    | "fixedWidth";
  preferences?: Record<string, DistributionYReportPreferencesV1>;
  onPreferencesChange?: (
    yColumnId: string,
    preferences: DistributionYReportPreferencesV1,
  ) => void;
  onEditInputs?: () => void;
  continuousFit?: DistributionContinuousFitConfigV1;
  onContinuousFitChange?: (continuousFit: DistributionContinuousFitConfigV1) => void;
  availableFitIds?: ContinuousDistributionIdV1[];
}

export const DEFAULT_DISTRIBUTION_REPORT_PREFERENCES: DistributionYReportPreferencesV1 = {
  overview: true,
  histogram: true,
  outlierBoxPlot: true,
  specificationLines: true,
  quantiles: true,
  summary: true,
  horizontalTables: true,
  normalQuantilePlot: false,
  quantileBoxPlot: false,
  stemAndLeaf: false,
  ecdf: false,
  processCapability: true,
  histogramScale: "density",
  capabilityHistogram: true,
  capabilityProcessSummary: true,
  capabilityWithin: true,
  capabilityOverall: true,
  capabilityNonconformance: true,
  fitOverlays: true,
  fitDetails: true,
};

type DisplayToggleKey =
  | "overview"
  | "quantiles"
  | "summary"
  | "ecdf"
  | "processCapability"
  | "normalQuantilePlot"
  | "quantileBoxPlot"
  | "stemAndLeaf";

function normalizeReportPreferences(
  preferences?: DistributionYReportPreferencesV1,
): DistributionYReportPreferencesV1 {
  return { ...DEFAULT_DISTRIBUTION_REPORT_PREFERENCES, ...preferences };
}

export function DistributionReport({
  groups,
  histogramMethod,
  preferences,
  onPreferencesChange,
  onEditInputs,
  continuousFit,
  onContinuousFitChange,
  availableFitIds = [],
}: DistributionReportProps) {
  return (
    <div className="distribution-report-tree">
      {groups.map((group, groupIndex) => (
        <GroupSection
          key={groupIdentity(group)}
          group={group}
          groupIndex={groupIndex}
          defaultOpen={groupIndex === 0}
          histogramMethod={histogramMethod}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
          onEditInputs={onEditInputs}
          continuousFit={continuousFit}
          onContinuousFitChange={onContinuousFitChange}
          availableFitIds={availableFitIds}
        />
      ))}
    </div>
  );
}

function GroupSection({
  group,
  groupIndex,
  defaultOpen,
  histogramMethod,
  preferences,
  onPreferencesChange,
  onEditInputs,
  continuousFit,
  onContinuousFitChange,
  availableFitIds,
}: {
  group: DistributionGroupResultV1;
  groupIndex: number;
  defaultOpen: boolean;
  histogramMethod?: DistributionReportProps["histogramMethod"];
  preferences?: Record<string, DistributionYReportPreferencesV1>;
  onPreferencesChange?: DistributionReportProps["onPreferencesChange"];
  onEditInputs?: () => void;
  continuousFit?: DistributionContinuousFitConfigV1;
  onContinuousFitChange?: (continuousFit: DistributionContinuousFitConfigV1) => void;
  availableFitIds: ContinuousDistributionIdV1[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const label = group.groupKey.length === 0
    ? t("distribution.report.overall")
    : group.groupKey.map((value, index) => {
        const formatted = formatGroupValue(value, t("distribution.report.missing"));
        const name = group.groupNames?.[index];
        return name ? `${name} = ${formatted}` : formatted;
      }).join(" / ");

  return (
    <section className="distribution-report-group" data-testid={`distribution-group-${groupIndex}`}>
      <button
        type="button"
        className="distribution-disclosure distribution-group-heading"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
      </button>
      {open && (
        <div className="distribution-group-content">
          {group.yResults.map((result, yIndex) => (
            <YSection
              key={result.yColumn.columnId}
              result={result}
              defaultOpen={yIndex === 0}
              histogramMethod={histogramMethod}
              preferences={preferences?.[result.yColumn.columnId]}
              onPreferencesChange={onPreferencesChange}
              onEditInputs={onEditInputs}
              continuousFit={continuousFit}
              onContinuousFitChange={onContinuousFitChange}
              availableFitIds={availableFitIds}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function YSection({
  result,
  defaultOpen,
  histogramMethod,
  preferences,
  onPreferencesChange,
  onEditInputs,
  continuousFit,
  onContinuousFitChange,
  availableFitIds,
}: {
  result: DistributionYResultV1;
  defaultOpen: boolean;
  histogramMethod?: DistributionReportProps["histogramMethod"];
  preferences?: DistributionYReportPreferencesV1;
  onPreferencesChange?: DistributionReportProps["onPreferencesChange"];
  onEditInputs?: () => void;
  continuousFit?: DistributionContinuousFitConfigV1;
  onContinuousFitChange?: (continuousFit: DistributionContinuousFitConfigV1) => void;
  availableFitIds: ContinuousDistributionIdV1[];
}) {
  const { t } = useTranslation();
  const menuId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localPreferences, setLocalPreferences] = useState(
    normalizeReportPreferences(preferences),
  );
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const visible = onPreferencesChange
    ? normalizeReportPreferences(preferences)
    : localPreferences;
  const updatePreferences = (next: DistributionYReportPreferencesV1) => {
    if (onPreferencesChange) {
      onPreferencesChange(result.yColumn.columnId, next);
    } else {
      setLocalPreferences(next);
    }
  };
  const options = [
    ["overview", t("distribution.report.overview")],
    ["quantiles", t("distribution.report.quantiles")],
    ["summary", t("distribution.report.summary")],
    ["ecdf", t("distribution.report.ecdf")],
    ["processCapability", t("distribution.report.processCapability")],
  ] as Array<[DisplayToggleKey, string]>;
  const histogramBlock = result.blocks.find((block) => block.chartData?.kind === "histogramData");
  const boxPlotBlock = result.blocks.find((block) => block.chartData?.kind === "boxPlotData");
  const summaryBlock = result.blocks.find((block) => block.kind === "summary" && !!block.summaryData);
  const capabilityBlock = result.blocks.find((block) => block.kind === "processCapability");
  const histogram = histogramBlock?.chartData?.kind === "histogramData" ? histogramBlock.chartData : null;
  const boxPlot = boxPlotBlock?.chartData?.kind === "boxPlotData" ? boxPlotBlock.chartData : null;
  const fitCurves = result.blocks.flatMap((block) => {
    const fit = block.distributionFitData;
    return fit?.status === "available" && fit.fittedCurve && fit.fittedCurve.points.length > 0
      ? [{ distributionId: fit.distributionId, points: fit.fittedCurve.points }]
      : [];
  });
  const hasNormalQuantile = result.blocks.some((block) => block.chartData?.kind === "normalQuantileData");
  const hasQuantileBox = result.blocks.some((block) => block.chartData?.kind === "quantileBoxData");
  const hasStemAndLeaf = result.blocks.some((block) => !!block.stemAndLeafData);
  const hasOverview = !!(histogram || boxPlot);
  const hasQuantiles = true;
  const hasSummary = result.blocks.some((block) => block.kind === "summary");
  const hasHorizontalTables = hasQuantiles && hasSummary;
  const hasSpecificationLines = !!capabilityBlock?.capabilityData?.specification;
  const displayOptions = options.filter(([key]) => {
    if (key === "overview") return hasOverview;
    if (key === "quantiles") return hasQuantiles;
    if (key === "summary") return hasSummary;
    return false;
  });
  const diagnosticOptions: Array<[DisplayToggleKey, string]> = [];
  if (hasNormalQuantile) {
    diagnosticOptions.push(["normalQuantilePlot", t("distribution.report.normalQuantilePlot")]);
  }
  if (hasQuantileBox) {
    diagnosticOptions.push(["quantileBoxPlot", t("distribution.letterValueQuantilePlot")]);
  }
  if (hasStemAndLeaf) {
    diagnosticOptions.push(["stemAndLeaf", t("distribution.report.stemAndLeaf")]);
  }
  if (result.blocks.some((block) => block.kind === "ecdf")) {
    diagnosticOptions.push(["ecdf", t("distribution.report.ecdf")]);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (menuRef.current?.contains(event.target)) return;
      if (menuButtonRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [menuOpen]);

  const overviewSpecificationLines = visible.specificationLines
    ? (capabilityBlock?.capabilityData?.chartData?.specificationLines
      ?? capabilityBlock?.capabilityData?.specification)
    : undefined;
  const showCombinedOverview = visible.overview && visible.histogram && visible.outlierBoxPlot && !!histogram && !!boxPlot;
  const showHistogramOnly = visible.overview && visible.histogram && !!histogram && (!boxPlot || !visible.outlierBoxPlot);
  const showBoxOnly = visible.overview && visible.outlierBoxPlot && !!boxPlot && (!histogram || !visible.histogram);
  const tablePairClassName = visible.horizontalTables
    ? "distribution-report-block distribution-table-pair"
    : "distribution-report-block distribution-table-pair distribution-table-pair-vertical";
  const methodLabel = histogramMethod
    ? t(`distribution.report.histogramMethod.${histogramMethod}`)
    : t("distribution.report.histogramMethod.unknown");

  return (
    <section className="distribution-y-section">
      <div className="distribution-y-header">
        <button
          type="button"
          className="distribution-disclosure distribution-y-heading"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span>{result.yName}</span>
        </button>
        <div className="distribution-analysis-menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            className="distribution-icon-button"
            aria-label={t("distribution.report.analysisOptions", { name: result.yName })}
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <i className="fa-solid fa-ellipsis" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              id={menuId}
              className="distribution-analysis-menu"
              role="region"
              aria-label={t("distribution.report.analysisOptions", { name: result.yName })}
            >
              {displayOptions.length > 0 && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.report.displayGroup")}</legend>
                  {displayOptions.map(([key, label]) => (
                    <label className="distribution-menu-option" key={key}>
                      <input
                        type="checkbox"
                        checked={visible[key]}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            [key]: !visible[key],
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                  {hasHorizontalTables && (
                    <label className="distribution-menu-option">
                      <input
                        type="checkbox"
                        checked={visible.horizontalTables}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            horizontalTables: !visible.horizontalTables,
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{t("distribution.report.horizontalTables")}</span>
                    </label>
                  )}
                </fieldset>
              )}

              {(histogram || boxPlot) && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.report.histogramGroup")}</legend>
                  {histogram && (
                    <label className="distribution-menu-option">
                      <input
                        type="checkbox"
                        checked={visible.histogram}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            histogram: !visible.histogram,
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{t("distribution.report.histogram")}</span>
                    </label>
                  )}
                  {boxPlot && (
                    <label className="distribution-menu-option">
                      <input
                        type="checkbox"
                        checked={visible.outlierBoxPlot}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            outlierBoxPlot: !visible.outlierBoxPlot,
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{t("distribution.report.outlierBoxPlot")}</span>
                    </label>
                  )}
                  {hasSpecificationLines && (
                    <label className="distribution-menu-option">
                      <input
                        type="checkbox"
                        checked={visible.specificationLines}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            specificationLines: !visible.specificationLines,
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{t("distribution.report.specificationLines")}</span>
                    </label>
                  )}
                  {histogram && (
                    <>
                      <div className="distribution-menu-inline-label">
                        {t("distribution.report.scale")}: {t("distribution.report.probabilityDensity")}
                      </div>
                      <div className="distribution-menu-method">{t("distribution.report.currentMethod", { method: methodLabel })}</div>
                      {onEditInputs && (
                        <button
                          type="button"
                          className="distribution-menu-action"
                          onClick={() => {
                            onEditInputs();
                            setMenuOpen(false);
                          }}
                        >
                          {t("distribution.editInputs")}
                        </button>
                      )}
                    </>
                  )}
                </fieldset>
              )}

              {diagnosticOptions.length > 0 && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.report.diagnosticPlotsGroup")}</legend>
                  {diagnosticOptions.map(([key, label]) => (
                    <label className="distribution-menu-option" key={key}>
                      <input
                        type="checkbox"
                        checked={visible[key]}
                        onChange={() => {
                          updatePreferences({
                            ...visible,
                            [key]: !visible[key],
                          });
                          setMenuOpen(false);
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </fieldset>
              )}

              {capabilityBlock && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.report.processCapability")}</legend>
                  <label className="distribution-menu-option">
                    <input
                      type="checkbox"
                      checked={visible.processCapability}
                      onChange={() => {
                        updatePreferences({
                          ...visible,
                          processCapability: !visible.processCapability,
                        });
                        setMenuOpen(false);
                      }}
                    />
                    <span>{t("distribution.report.processCapability")}</span>
                  </label>
                </fieldset>
              )}

              {continuousFit && onContinuousFitChange && availableFitIds.length > 0 && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.fit.continuousFit", { defaultValue: "Continuous Fit" })}</legend>
                  {DISTRIBUTION_FIT_CAPABILITY_REGISTRY
                    .filter((capability) => capability.implemented && availableFitIds.includes(capability.distributionId))
                    .map((capability) => (
                      <label className="distribution-menu-option" key={capability.distributionId}>
                        <input
                          type="checkbox"
                          checked={!continuousFit.fitAll && continuousFit.enabledDistributionIds.includes(capability.distributionId)}
                          onChange={() => {
                            const selected = continuousFit.enabledDistributionIds.includes(capability.distributionId);
                            onContinuousFitChange({
                              ...continuousFit,
                              fitAll: false,
                              enabledDistributionIds: selected
                                ? continuousFit.enabledDistributionIds.filter((id) => id !== capability.distributionId)
                                : [...continuousFit.enabledDistributionIds, capability.distributionId],
                            });
                            setMenuOpen(false);
                          }}
                        />
                        <span>{t(`distribution.fit.commands.${capability.distributionId}`, {
                          defaultValue: `Fit ${capability.distributionId[0].toUpperCase()}${capability.distributionId.slice(1)}`,
                        })}</span>
                      </label>
                    ))}
                  <label className="distribution-menu-option">
                    <input
                      type="checkbox"
                      checked={continuousFit.fitAll}
                      onChange={() => {
                        onContinuousFitChange({
                          ...continuousFit,
                          fitAll: !continuousFit.fitAll,
                          enabledDistributionIds: [],
                        });
                        setMenuOpen(false);
                      }}
                    />
                    <span>{t("distribution.fit.fitAll", { defaultValue: "Fit All" })}</span>
                  </label>
                </fieldset>
              )}

              {result.blocks.some((block) => !!block.distributionFitData) && (
                <fieldset className="distribution-menu-group">
                  <legend>{t("distribution.fit.display", { defaultValue: "Fit Display" })}</legend>
                  <label className="distribution-menu-option">
                    <input
                      type="checkbox"
                      checked={visible.fitOverlays !== false}
                      onChange={() => {
                        updatePreferences({ ...visible, fitOverlays: visible.fitOverlays === false });
                        setMenuOpen(false);
                      }}
                    />
                    <span>{t("distribution.fit.showOverlays", { defaultValue: "Show Fit Curves" })}</span>
                  </label>
                  <label className="distribution-menu-option">
                    <input
                      type="checkbox"
                      checked={visible.fitDetails !== false}
                      onChange={() => {
                        updatePreferences({ ...visible, fitDetails: visible.fitDetails === false });
                        setMenuOpen(false);
                      }}
                    />
                    <span>{t("distribution.fit.showDetails", { defaultValue: "Show Fit Details" })}</span>
                  </label>
                </fieldset>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="distribution-y-content">
          {showCombinedOverview && (
            <section className="distribution-report-block">
              <DistributionOverviewChart
                histogram={histogram}
                boxPlot={boxPlot}
                title={t("distribution.report.overview")}
                valueAxisName={result.yName}
                specificationLines={overviewSpecificationLines}
              />
            </section>
          )}
          {showHistogramOnly && histogram && (
            <section className="distribution-report-block">
              <DistributionOverviewChart
                histogram={histogram}
                boxPlot={null}
                title={t("distribution.report.overview")}
                valueAxisName={result.yName}
                specificationLines={overviewSpecificationLines}
              />
            </section>
          )}
          {showBoxOnly && boxPlotBlock && <ReportBlock block={boxPlotBlock} />}
          {histogram && fitCurves.length > 0 && visible.fitOverlays !== false && (
            <section className="distribution-report-block">
              <DistributionFitDensityChart
                histogram={histogram}
                curves={fitCurves}
                title={t("distribution.report.fitDensity")}
                valueAxisName={result.yName}
                densityAxisName={t("distribution.report.probabilityDensity")}
              />
            </section>
          )}
          {(visible.quantiles || visible.summary) && (hasQuantiles || hasSummary) && (
            <section className={tablePairClassName}>
              {visible.quantiles && hasQuantiles && (
                <div>
                  <h3>{t("distribution.report.quantiles")}</h3>
                  <table className="distribution-quantile-table">
                    <thead>
                      <tr>
                        <th>{t("distribution.report.probability")}</th>
                        <th>{t("distribution.report.label")}</th>
                        <th>{t("distribution.report.value")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.quantiles.map((quantile) => (
                        <tr key={quantile.probability}>
                          <th scope="row">{formatProbability(quantile.probability)}</th>
                          <td>{quantileLabel(quantile.probability, t)}</td>
                          <td>{formatNumber(quantile.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {visible.summary && summaryBlock?.summaryData && (
                <div>
                  <h3>{t("distribution.report.summary")}</h3>
                  <SummaryDataTables summaryData={summaryBlock.summaryData} />
                </div>
              )}
            </section>
          )}
          {result.blocks
            .filter((block) => block !== histogramBlock && block !== boxPlotBlock && block !== summaryBlock)
            .filter((block) => isBlockVisible(block.kind, visible))
            .filter((block) => visible.fitDetails !== false ||
              (!block.distributionFitData && !block.distributionFitComparisonData))
            .map((block) => <ReportBlock
              key={block.blockId}
              block={block}
              valueAxisName={result.yName}
              preferences={visible}
              onPreferencesChange={updatePreferences}
            />)}
        </div>
      )}
    </section>
  );
}

export function ReportBlock({
  block,
  valueAxisName,
  preferences,
  onPreferencesChange,
}: {
  block: DistributionReportBlockV1;
  valueAxisName?: string;
  preferences?: DistributionYReportPreferencesV1;
  onPreferencesChange?: (preferences: DistributionYReportPreferencesV1) => void;
}) {
  const { t } = useTranslation();
  const unavailableReasonCode = getUnavailableReasonCode(block);
  const compatibilityStatus = getCompatibilityStatus(block);
  const titleKey = block.kind === "quantileBox"
    ? "distribution.letterValueQuantilePlot"
    : block.titleKey;
  const blockTitle = block.distributionFitData
    ? `${t(titleKey)} - ${t(`distribution.fit.distributions.${block.distributionFitData.distributionId}`, {
      defaultValue: block.distributionFitData.distributionId,
    })}`
    : t(titleKey);
  return (
    <section className="distribution-report-block" data-testid={`distribution-report-block-${block.blockId}`}>
      <h3>{blockTitle}</h3>
      {compatibilityStatus && (
        <p className="distribution-compatibility-status">
          {t(`distribution.compatibility.${compatibilityStatus}`)}
        </p>
      )}
      {unavailableReasonCode && (
        <p className="distribution-report-unavailable" data-testid={`distribution-report-unavailable-${block.blockId}`}>
          {t("distribution.report.unavailableReason", { reason: unavailableReasonCode })}
        </p>
      )}
      {block.summaryData && <SummaryDataTables summaryData={block.summaryData} />}
      {block.chartData && <DistributionChart chart={block.chartData} title={t(titleKey)} />}
      {block.stemAndLeafData && <StemAndLeafReport data={block.stemAndLeafData} />}
      {block.distributionFitData && <ContinuousFitReport data={block.distributionFitData} />}
      {block.distributionFitComparisonData && <ContinuousFitComparisonReport data={block.distributionFitComparisonData} />}
      {block.capabilityData && <ProcessCapabilityReport
        data={block.capabilityData}
        valueAxisName={valueAxisName ?? t("distribution.report.value")}
        preferences={preferences ?? DEFAULT_DISTRIBUTION_REPORT_PREFERENCES}
        onPreferencesChange={onPreferencesChange}
      />}
    </section>
  );
}

function SummaryDataTables({
  summaryData,
}: {
  summaryData: NonNullable<DistributionReportBlockV1["summaryData"]>;
}) {
  const { t } = useTranslation();
  return (
    <div className="distribution-summary-tables">
      <SummaryTable title={t("distribution.report.location")} rows={[
        ["n", summaryData.n], ["nMissing", summaryData.nMissing],
        ["mean", summaryData.mean], ["median", summaryData.median],
        ["mode", summaryData.modeIsUnique
          ? summaryData.primaryMode
          : t("distribution.statistics.noUniqueMode")], ["minimum", summaryData.minimum],
        ["maximum", summaryData.maximum],
      ]} />
      <SummaryTable title={t("distribution.report.variation")} rows={[
        ["stdDev", summaryData.stdDev], ["stdError", summaryData.stdError],
        ["meanCiLower", summaryData.meanCiLower], ["meanCiUpper", summaryData.meanCiUpper],
        ["range", summaryData.range], ["iqr", summaryData.iqr], ["mad", summaryData.mad],
      ]} />
    </div>
  );
}

function SummaryTable({ title, rows }: { title: string; rows: Array<[string, number | string | null]> }) {
  const { t } = useTranslation();
  return (
    <table className="distribution-summary-table">
      <caption>{title}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{t(`distribution.statistics.${label}`)}</th>
            <td>{typeof value === "number" ? formatNumber(value) : value ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function isBlockVisible(
  kind: string,
  visible: Record<
    | "overview"
    | "quantiles"
    | "summary"
    | "ecdf"
    | "processCapability"
    | "normalQuantilePlot"
    | "quantileBoxPlot"
    | "stemAndLeaf",
    boolean
  >,
): boolean {
  if (kind === "histogram" || kind === "boxPlot") return visible.overview;
  if (kind === "summary") return visible.summary;
  if (kind === "ecdf") return visible.ecdf;
  if (kind === "processCapability") return visible.processCapability;
  if (kind === "normalQuantile") return visible.normalQuantilePlot;
  if (kind === "quantileBox") return visible.quantileBoxPlot;
  if (kind === "stemAndLeaf") return visible.stemAndLeaf;
  return true;
}

function getCompatibilityStatus(
  block: DistributionReportBlockV1,
): "intentionalDifference" | "compatibilityPending" | null {
  const status = block.stemAndLeafData?.provenance.compatibilityStatus ??
    block.chartData?.provenance.compatibilityStatus;
  return status === "intentionalDifference" || status === "compatibilityPending"
    ? status
    : null;
}

function getUnavailableReasonCode(block: DistributionReportBlockV1): string | null {
  if (block.status !== "unavailable") {
    return null;
  }
  if (block.stemAndLeafData?.status === "unavailable") {
    return block.stemAndLeafData.reasonCode;
  }
  if (block.chartData?.kind === "normalQuantileData") {
    return block.chartData.payload.reasonCode;
  }
  if (block.chartData?.kind === "quantileBoxData") {
    return block.chartData.payload.reasonCode;
  }
  return null;
}

function quantileLabel(probability: number, t: (key: string) => string): string {
  if (probability === 0) return t("distribution.statistics.minimum");
  if (probability === 0.25) return "Q1";
  if (probability === 0.5) return t("distribution.statistics.median");
  if (probability === 0.75) return "Q3";
  if (probability === 1) return t("distribution.statistics.maximum");
  return "";
}

function groupIdentity(group: DistributionGroupResultV1): string {
  return group.groupKey.length === 0 ? "overall" : JSON.stringify(group.groupKey);
}

function formatGroupValue(value: DistributionGroupValueV1, missing: string): string {
  switch (value.kind) {
    case "missing": return missing;
    case "dateTime": return new Date(value.utcMillis).toLocaleString();
    case "boolean": return String(value.value);
    case "number": return formatNumber(value.value);
    case "text": return value.value;
  }
}

function formatProbability(probability: number): string {
  return `${Number.parseFloat((probability * 100).toFixed(3))}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}
