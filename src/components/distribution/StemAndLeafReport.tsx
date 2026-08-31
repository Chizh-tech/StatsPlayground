import { useTranslation } from "react-i18next";

import type { StemAndLeafDataV1 } from "@/types/distribution";

interface StemAndLeafReportProps {
  data: StemAndLeafDataV1;
}

export function StemAndLeafReport({ data }: StemAndLeafReportProps) {
  const { t } = useTranslation();

  return (
    <div className="distribution-stem-and-leaf" data-testid="distribution-stem-and-leaf">
      <p className="distribution-stem-meta">
        <span>{t("distribution.leafUnit", { defaultValue: "Leaf unit" })}: {formatScale(data.leafUnit)}</span>
        <span>{t("distribution.stemKey", {
          defaultValue: "Key: {{stem}}|{{leaf}} represents {{value}}",
          stem: data.interpretationKey.stem,
          leaf: data.interpretationKey.leaf,
          value: formatScale(data.interpretationKey.value),
        })}</span>
        <span>{t("distribution.report.omittedStems")}: {data.omittedStemCount.toLocaleString()}</span>
        <span>{t("distribution.report.omittedLeaves")}: {data.omittedLeafCount.toLocaleString()}</span>
      </p>
      <table className="distribution-stem-table" aria-label={t("distribution.report.stemAndLeaf") }>
        <thead>
          <tr>
            <th scope="col">{t("distribution.report.stem")}</th>
            <th scope="col">{t("distribution.report.leaves")}</th>
            <th scope="col">{t("distribution.capability.count", { defaultValue: "Count" })}</th>
            <th scope="col">{t("distribution.report.omitted")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.stem}>
              <th scope="row">{row.stem}</th>
              <td>
                <pre className="distribution-stem-leaf-text">{row.leaves.join(" ")}</pre>
              </td>
              <td>{row.count.toLocaleString()}</td>
              <td>{row.omittedLeafCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatScale(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "1";
  }
  if (value >= 1 && Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return value.toPrecision(6).replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
}
