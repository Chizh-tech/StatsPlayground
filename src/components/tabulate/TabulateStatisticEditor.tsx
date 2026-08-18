import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import type { TabulateStatistic, TabulateStatisticKind } from "@/types/tabulate";

import type { TabulateFieldInfo } from "./TabulateFieldList";
import { parseQuantileInput } from "./tabulateResult";

interface TabulateStatisticEditorProps {
  open: boolean;
  fields: readonly TabulateFieldInfo[];
  initialStatistic: TabulateStatistic;
  onClose: () => void;
  onSave: (nextStatistic: TabulateStatistic) => void;
}

interface StatisticOption {
  kind: TabulateStatisticKind;
  label: string;
  numericOnly: boolean;
}

export const STATISTIC_OPTIONS: readonly StatisticOption[] = [
  { kind: "count", label: "Count", numericOnly: false },
  { kind: "missingCount", label: "Missing Count", numericOnly: false },
  { kind: "uniqueCount", label: "Unique Count", numericOnly: false },
  { kind: "sum", label: "Sum", numericOnly: true },
  { kind: "mean", label: "Mean", numericOnly: true },
  { kind: "standardDeviation", label: "Standard Deviation", numericOnly: true },
  { kind: "variance", label: "Variance", numericOnly: true },
  { kind: "minimum", label: "Minimum", numericOnly: true },
  { kind: "maximum", label: "Maximum", numericOnly: true },
  { kind: "median", label: "Median", numericOnly: true },
  { kind: "range", label: "Range", numericOnly: true },
  { kind: "quantile", label: "Quantile", numericOnly: true },
  { kind: "rowPercentage", label: "Row %", numericOnly: false },
  { kind: "columnPercentage", label: "Column %", numericOnly: false },
  { kind: "totalPercentage", label: "Total %", numericOnly: false },
];

const NUMERIC_STATISTIC_KINDS = new Set<TabulateStatisticKind>([
  "sum",
  "mean",
  "standardDeviation",
  "variance",
  "minimum",
  "maximum",
  "median",
  "range",
  "quantile",
]);

export function defaultStatisticKindForField(field: TabulateFieldInfo): TabulateStatisticKind {
  return field.numeric ? "mean" : "count";
}

export function isNumericStatisticKind(kind: TabulateStatisticKind): boolean {
  return NUMERIC_STATISTIC_KINDS.has(kind);
}

export function formatStatisticLabel(statistic: Pick<TabulateStatistic, "kind" | "quantile">): string {
  const label = i18n.t(`tabulate.${statistic.kind}`);
  if (statistic.kind === "quantile") {
    const probability = statistic.quantile == null ? null : Number(statistic.quantile);
    if (probability == null || Number.isNaN(probability)) {
      return label;
    }
    return `${label} (${probability.toFixed(2)})`;
  }
  return label;
}

export function TabulateStatisticEditor({
  open,
  fields,
  initialStatistic,
  onClose,
  onSave,
}: TabulateStatisticEditorProps) {
  const { t } = useTranslation();
  const [fieldName, setFieldName] = useState(initialStatistic.field);
  const [kind, setKind] = useState<TabulateStatisticKind>(initialStatistic.kind);
  const [quantileText, setQuantileText] = useState(
    initialStatistic.quantile == null ? "0.50" : String(initialStatistic.quantile),
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setFieldName(initialStatistic.field);
    setKind(initialStatistic.kind);
    setQuantileText(initialStatistic.quantile == null ? "0.50" : String(initialStatistic.quantile));
  }, [initialStatistic, open]);

  const selectedField = useMemo(() => {
    return fields.find(({ name }) => name === fieldName) ?? fields[0] ?? null;
  }, [fieldName, fields]);

  useEffect(() => {
    if (!open || !selectedField) {
      return;
    }
    if (!selectedField.numeric && isNumericStatisticKind(kind)) {
      setKind("count");
    }
  }, [kind, open, selectedField]);

  if (!open) {
    return null;
  }

  const quantileValue = parseQuantileInput(quantileText);
  const quantileValid = quantileValue != null;
  const kindRequiresNumericField = isNumericStatisticKind(kind);
  const canSave =
    selectedField != null
    && (!kindRequiresNumericField || selectedField.numeric)
    && (kind !== "quantile" || quantileValid);

  return (
    <div className="sp-dialog-overlay" onMouseDown={onClose}>
      <div className="sp-dialog sp-tabulate-stat-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sp-dialog-title">{t("tabulate.statistic")}</div>
        <div className="sp-dialog-body sp-tabulate-stat-dialog-body">
          <label className="sp-tabulate-form-field">
            <span className="sp-tabulate-form-label">{t("tabulate.field")}</span>
            <select value={fieldName} onChange={(event) => setFieldName(event.target.value)}>
              {fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </label>

          <label className="sp-tabulate-form-field">
            <span className="sp-tabulate-form-label">{t("tabulate.statistic")}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as TabulateStatisticKind)}
            >
              {STATISTIC_OPTIONS.map((option) => (
                <option
                  key={option.kind}
                  value={option.kind}
                  disabled={option.numericOnly && !selectedField?.numeric}
                >
                  {t(`tabulate.${option.kind}`)}
                </option>
              ))}
            </select>
          </label>

          {kind === "quantile" ? (
            <label className="sp-tabulate-form-field">
              <span className="sp-tabulate-form-label">{t("tabulate.probability")}</span>
              <input
                type="number"
                value={quantileText}
                min={0}
                max={1}
                step={0.01}
                onChange={(event) => setQuantileText(event.target.value)}
                aria-invalid={!quantileValid}
              />
              <span className="sp-tabulate-form-help">{t("tabulate.probabilityHelp")}</span>
            </label>
          ) : null}
        </div>
        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-dialog-btn sp-dialog-btn-primary"
            disabled={!canSave}
            onClick={() => {
              if (!selectedField) {
                return;
              }
              if (kind === "quantile" && !quantileValid) {
                return;
              }
              onSave({
                ...initialStatistic,
                field: selectedField.name,
                kind,
                quantile: kind === "quantile" ? quantileValue ?? undefined : undefined,
              });
            }}
          >
            {t("common.apply")}
          </button>
          <button type="button" className="sp-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}