import { useState } from "react";

import { ReportView, type ReportLinkOption } from "../src/components/report/ReportView";
import type { ReportItem } from "../src/types/report";

const baseItem: ReportItem = {
  schemaVersion: 1,
  id: "report-1",
  name: "Weekly Summary",
  markdown: "",
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const tableOptions: ReportLinkOption[] = [{ id: "table-1", name: "Incoming Data" }];
const graphOptions: ReportLinkOption[] = [{ id: "graph-1", name: "Scatter Plot" }];
const fitYByXOptions: ReportLinkOption[] = [{ id: "fit-1", name: "Strength vs Time" }];
const tabulateOptions: ReportLinkOption[] = [{ id: "tab-1", name: "Grouped Summary" }];

export function ReportViewHarness({ initialMarkdown = "" }: { initialMarkdown?: string }) {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  return (
    <ReportView
      item={{ ...baseItem, markdown, updatedAt: "2026-09-02T10:05:00.000Z" }}
      tableOptions={tableOptions}
      graphOptions={graphOptions}
      fitYByXOptions={fitYByXOptions}
      tabulateOptions={tabulateOptions}
      onMarkdownChange={setMarkdown}
    />
  );
}