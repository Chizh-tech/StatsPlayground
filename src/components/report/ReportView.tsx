import { useTranslation } from "react-i18next";

import type { ReportItem } from "@/types/report";

export function ReportView({ item }: { item: ReportItem }) {
  const { t } = useTranslation();

  return (
    <div className="main-content">
      <div className="workspace-empty">
        <h2>{item.name}</h2>
        <p>{t("report.placeholder")}</p>
      </div>
    </div>
  );
}
