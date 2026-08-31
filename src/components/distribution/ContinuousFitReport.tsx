import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import type {
  CapabilityTypedValueV1,
  DistributionFitComparisonDataV1,
  DistributionFitDataV1,
} from "@/types/distribution";

function formatValue(value: CapabilityTypedValueV1): string {
  if (value.state !== "available" || value.value === null || !Number.isFinite(value.value)) {
    return value.reasonCode ?? "—";
  }
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(value.value);
}

function reasonCategory(code: string): string | null {
  if (!code.startsWith("distribution.fit.")) return null;
  if (code.includes("DomainInvalid")) return "domainInvalid";
  if (code.includes("constantSample")) return "constantSample";
  if (code.includes("observationsEmpty")) return "observationsEmpty";
  if (code.includes("optimizer") || code.includes("iterationLimit") || code.includes("toleranceInvalid")) return "optimizationFailed";
  if (code.includes("curve") || code.includes("pdf")) return "curveInvalid";
  if (code.includes("Likelihood") || code.includes("Criteria") || code.includes("aicc")) return "metricInvalid";
  if (code.includes("estimate")) return "estimateInvalid";
  if (code.includes("observation") || code.includes("effectiveN") || code.includes("positiveTransform")) return "inputInvalid";
  return null;
}

function formatReason(t: TFunction, code: string): string {
  const category = reasonCategory(code);
  return category
    ? t(`distribution.fitReasons.${category}`, { defaultValue: code })
    : code;
}

export function ContinuousFitReport({ data }: { data: DistributionFitDataV1 }) {
  const { t } = useTranslation();
  const distribution = t(`distribution.fit.distributions.${data.distributionId}`, {
    defaultValue: data.distributionId,
  });

  if (data.status !== "available") {
    const reason = data.reasonCode
      ? formatReason(t, data.reasonCode)
      : t(`distribution.fit.states.${data.status}`, { defaultValue: data.status });
    return (
      <div className="distribution-fit-report">
        <p className="distribution-report-unavailable">
          {t("distribution.fit.unavailable", {
            defaultValue: "Fit unavailable: {{reason}}",
            reason,
          })}
        </p>
      </div>
    );
  }

  const metrics = [
    ["logLikelihood", data.logLikelihood],
    ["aic", data.aic],
    ["aicc", data.aicc],
    ["bic", data.bic],
  ] as const;

  return (
    <div className="distribution-fit-report">
      <p className="distribution-compatibility-status">
        {t(`distribution.compatibility.${data.provenance.compatibilityStatus}`)}
      </p>
      <div className="distribution-fit-tables">
        <table className="distribution-fit-table" aria-label={`${distribution} parameters`}>
          <caption>{t("distribution.fit.parameters", { defaultValue: "Parameter Estimates" })}</caption>
          <thead><tr><th>{t("distribution.fit.parameter", { defaultValue: "Parameter" })}</th><th>{t("distribution.report.value")}</th></tr></thead>
          <tbody>
            {data.parameters.map((parameter) => (
              <tr key={parameter.parameterId}>
                <th scope="row">{t(`distribution.fit.parametersById.${parameter.parameterId}`, { defaultValue: parameter.parameterId })}</th>
                <td>{formatValue(parameter.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="distribution-fit-table" aria-label={`${distribution} fit statistics`}>
          <caption>{t("distribution.fit.statistics", { defaultValue: "Fit Statistics" })}</caption>
          <thead><tr><th>{t("distribution.fit.metric", { defaultValue: "Metric" })}</th><th>{t("distribution.report.value")}</th></tr></thead>
          <tbody>
            {metrics.map(([metricId, value]) => (
              <tr key={metricId}>
                <th scope="row">{t(`distribution.fit.metrics.${metricId}`, { defaultValue: metricId })}</th>
                <td>{formatValue(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="distribution-fit-convergence">
        {t("distribution.fit.convergence", { defaultValue: "Convergence" })}: {t(`distribution.fit.states.${data.convergence.status}`, { defaultValue: data.convergence.status })}
        {data.convergence.reasonCode ? ` (${formatReason(t, data.convergence.reasonCode)})` : ""}
      </p>
    </div>
  );
}

export function ContinuousFitComparisonReport({ data }: { data: DistributionFitComparisonDataV1 }) {
  const { t } = useTranslation();
  return (
    <table className="distribution-fit-table distribution-fit-comparison" aria-label={t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}>
      <caption>{t("distribution.fit.comparison", { defaultValue: "Fit Comparison" })}</caption>
      <thead>
        <tr>
          <th>{t("distribution.fit.distribution", { defaultValue: "Distribution" })}</th>
          <th>AICc</th>
          <th>AIC</th>
          <th>BIC</th>
          <th>{t("distribution.fit.status", { defaultValue: "Status" })}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => (
          <tr key={row.distributionId}>
            <th scope="row">{t(`distribution.fit.distributions.${row.distributionId}`, { defaultValue: row.distributionId })}</th>
            <td>{formatValue(row.aicc)}</td>
            <td>{formatValue(row.aic)}</td>
            <td>{formatValue(row.bic)}</td>
            <td>{row.reasonCode
              ? formatReason(t, row.reasonCode)
              : t(`distribution.fit.states.${row.status}`, { defaultValue: row.status })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
