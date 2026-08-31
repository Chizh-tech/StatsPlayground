import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  CapabilityTypedValueV1,
  ProcessCapabilityDataV1,
  ProcessCapabilityIntervalV1,
  DistributionYReportPreferencesV1,
} from "@/types/distribution";

import { ProcessCapabilityChart } from "./DistributionChart";

export function ProcessCapabilityReport({
  data,
  valueAxisName,
  preferences,
  onPreferencesChange,
}: {
  data: ProcessCapabilityDataV1;
  valueAxisName: string;
  preferences: DistributionYReportPreferencesV1;
  onPreferencesChange?: (preferences: DistributionYReportPreferencesV1) => void;
}) {
  const { t } = useTranslation();
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [localPreferences, setLocalPreferences] = useState(preferences);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const effectivePreferences = onPreferencesChange ? preferences : localPreferences;
  const visible = {
    histogram: effectivePreferences.capabilityHistogram,
    processSummary: effectivePreferences.capabilityProcessSummary,
    within: effectivePreferences.capabilityWithin,
    overall: effectivePreferences.capabilityOverall,
    nonconformance: effectivePreferences.capabilityNonconformance,
  };
  const preferenceKey = {
    histogram: "capabilityHistogram",
    processSummary: "capabilityProcessSummary",
    within: "capabilityWithin",
    overall: "capabilityOverall",
    nonconformance: "capabilityNonconformance",
  } as const;
  const specificationRows = [
    ["lsl", data.specification.lsl],
    ["target", data.specification.target],
    ["usl", data.specification.usl],
  ] as const;
  const summaryRows = [
    ["n", data.processSummary.n],
    ["mean", data.processSummary.mean],
    ["movingRangeAverage", data.processSummary.movingRangeAverage],
    ["withinSigma", data.processSummary.withinSigma],
    ["overallSigma", data.processSummary.overallSigma],
  ] as const;
  const withinRows = [
    ["cp", data.indices.cp],
    ["cpk", data.indices.cpk],
    ["cpl", data.indices.cpl],
    ["cpu", data.indices.cpu],
    ["cpmWithin", data.indices.cpmWithin],
  ] as const;
  const overallRows = [
    ["pp", data.indices.pp],
    ["ppk", data.indices.ppk],
    ["ppl", data.indices.ppl],
    ["ppu", data.indices.ppu],
    ["cpmOverall", data.indices.cpmOverall],
  ] as const;

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

  return (
    <div className="distribution-capability-report">
      <div className="distribution-capability-toolbar">
        <span />
        <div className="distribution-analysis-menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            className="distribution-icon-button"
            aria-label={t("distribution.capability.options")}
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
              aria-label={t("distribution.capability.options")}
            >
              <fieldset className="distribution-menu-group">
                <legend>{t("distribution.report.processCapability")}</legend>
                {([
                  ...(data.chartData ? ["histogram" as const] : []),
                  "processSummary" as const,
                  "within" as const,
                  "overall" as const,
                  "nonconformance" as const,
                ]).map((key) => (
                  <label className="distribution-menu-option" key={key}>
                    <input
                      type="checkbox"
                      checked={visible[key]}
                      onChange={() => {
                        const next = {
                          ...effectivePreferences,
                          [preferenceKey[key]]: !visible[key],
                        };
                        if (onPreferencesChange) onPreferencesChange(next);
                        else setLocalPreferences(next);
                        setMenuOpen(false);
                      }}
                    />
                    <span>{t(`distribution.capability.${key}`)}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          )}
        </div>
      </div>
      {visible.histogram && data.chartData && (
        <ProcessCapabilityChart
          chart={data.chartData}
          title={t("distribution.capability.histogram")}
          valueAxisName={valueAxisName}
          densityAxisName={t("distribution.report.probabilityDensity")}
        />
      )}
      <div className="distribution-capability-summary">
        <table>
          <caption>{t("distribution.capability.specification")}</caption>
          <tbody>
            {specificationRows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label.toUpperCase()}</th>
                <td>{formatNumber(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.processSummary && <table>
          <caption>{t("distribution.capability.processSummary")}</caption>
          <tbody>
            {summaryRows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{t(`distribution.capability.${label}`)}</th>
                <td>{formatNumber(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>}
      </div>
      <div className="distribution-capability-indices">
        {visible.within && <IndexTable
          title={t("distribution.capability.within")}
          rows={withinRows}
          intervals={data.intervals}
        />}
        {visible.overall && <IndexTable
          title={t("distribution.capability.overall")}
          rows={overallRows}
          intervals={data.intervals}
        />}
      </div>
      {visible.nonconformance && <NonconformanceTable data={data.nonconformance} />}
      {data.warnings.map((warning) => (
        <p className="distribution-capability-warning" key={warning}>{t(warning)}</p>
      ))}
    </div>
  );
}

function IndexTable({
  title,
  rows,
  intervals,
}: {
  title: string;
  rows: ReadonlyArray<readonly [string, CapabilityTypedValueV1]>;
  intervals: ProcessCapabilityDataV1["intervals"];
}) {
  const { t } = useTranslation();
  return (
    <table>
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">{t("distribution.capability.index")}</th>
          <th scope="col">{t("distribution.capability.estimate")}</th>
          <th scope="col">{t("distribution.capability.lowerCi")}</th>
          <th scope="col">{t("distribution.capability.upperCi")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => {
          const interval = intervalFor(label, intervals);
          return (
          <tr key={label}>
            <th scope="row">{label.startsWith("cpm") ? "cpm" : label}</th>
            <td>{formatTypedValue(value, t)}</td>
            <td>{formatTypedValue(interval.lower, t)}</td>
            <td>{formatTypedValue(interval.upper, t)}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function intervalFor(
  label: string,
  intervals: ProcessCapabilityDataV1["intervals"],
): ProcessCapabilityIntervalV1 {
  return intervals[label as keyof Omit<typeof intervals, "provenance">] as ProcessCapabilityIntervalV1;
}

function NonconformanceTable({ data }: { data: ProcessCapabilityDataV1["nonconformance"] }) {
  const { t } = useTranslation();
  const rows = [
    ["below", data.observed.below, data.expectedWithin.below, data.expectedOverall.below],
    ["above", data.observed.above, data.expectedWithin.above, data.expectedOverall.above],
    ["total", data.observed.total, data.expectedWithin.total, data.expectedOverall.total],
  ] as const;
  return (
    <table className="distribution-nonconformance-table">
      <caption>{t("distribution.capability.nonconformance")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("distribution.capability.region")}</th>
          <th scope="col">{t("distribution.capability.observedCount")}</th>
          <th scope="col">{t("distribution.capability.observedPpm")}</th>
          <th scope="col">{t("distribution.capability.expectedWithinPpm")}</th>
          <th scope="col">{t("distribution.capability.expectedOverallPpm")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([tail, observed, expectedWithin, expectedOverall]) => (
          <tr key={tail}>
            <th scope="row">{t(`distribution.capability.${tail}`)}</th>
            <td>{formatTypedCount(observed.count, t)}</td>
            <td>{formatTypedValue(observed.ppm, t)}</td>
            <td>{formatTypedValue(expectedWithin.ppm, t)}</td>
            <td>{formatTypedValue(expectedOverall.ppm, t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatTypedCount(
  value: ProcessCapabilityDataV1["nonconformance"]["observed"]["total"]["count"],
  t: (key: string) => string,
): string {
  if (value.state === "available" && value.value !== null) return value.value.toLocaleString();
  return t(`distribution.capability.states.${value.state}`);
}

function formatTypedValue(
  value: CapabilityTypedValueV1,
  t: (key: string) => string,
): string {
  if (value.state === "available" && value.value !== null) return formatNumber(value.value);
  return t(`distribution.capability.states.${value.state}`);
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}
