import { useEffect, useState } from "react";

import { ReportView, type ReportLinkOption } from "../src/components/report/ReportView";
import type { ReportEmbedRuntime } from "../src/components/report/ReportEmbed.tsx";
import { useDataStore } from "../src/stores/useDataStore.ts";
import { useFitYByXStore } from "../src/stores/useFitYByXStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { FitYByXItem } from "../src/types/fitYByX.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";
import type { ReportItem } from "../src/types/report";
import type { TabulateItem } from "../src/types/tabulate.ts";

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

const defaultDataset: DatasetMeta = {
  id: "table-1",
  name: "Incoming Data",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 24,
  colCount: 4,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const defaultGraph: GraphBuilderItem = {
  id: "graph-1",
  name: "Scatter Plot",
  sourceDatasetId: defaultDataset.id,
  mode: "2d",
  modeStates: {
    twoD: {
      encoding: {},
      multiX: [],
      multiY: [],
      elements: [],
      smootherLambda: 0,
    },
    threeD: {
      encoding: {},
      elements: [],
      smootherLambda: 0,
    },
    multivariate: {
      columns: [],
      chartType: "correlationMatrix",
      correlationMethod: "pearson",
    },
  },
  filters: [],
  sampling: { mode: "full" },
  createdAt: "2026-09-02T10:00:00.000Z",
};

const defaultFitYByX: FitYByXItem = {
  id: "fit-1",
  name: "Strength vs Time",
  sourceDatasetId: defaultDataset.id,
  response: { name: "strength", type: "continuous" },
  factor: { name: "time", type: "continuous" },
  personality: "bivariate",
  graph: {
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [],
        smootherLambda: 0,
      },
      threeD: {
        encoding: {},
        elements: [],
        smootherLambda: 0,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [],
    sampling: { mode: "full" },
  },
  createdAt: "2026-09-02T10:00:00.000Z",
};

const defaultTabulate: TabulateItem = {
  id: "tab-1",
  name: "Grouped Summary",
  sourceDatasetId: defaultDataset.id,
  rowFields: ["supplier"],
  columnFields: ["phase"],
  statistics: [{ id: "count", field: "strength", kind: "count" }],
  includeRowTotals: true,
  includeColumnTotals: true,
  createdAt: "2026-09-02T10:00:00.000Z",
};

interface ReportViewHarnessProps {
  initialMarkdown?: string;
  embedRuntime?: ReportEmbedRuntime;
  datasets?: DatasetMeta[];
  graphs?: GraphBuilderItem[];
  fitYByX?: FitYByXItem[];
  tabulates?: TabulateItem[];
  graphMode?: "runtime" | "stub" | "error";
}

export function ReportViewHarness({
  initialMarkdown = "",
  embedRuntime,
  datasets = [defaultDataset],
  graphs = [defaultGraph],
  fitYByX = [defaultFitYByX],
  tabulates = [defaultTabulate],
  graphMode = "runtime",
}: ReportViewHarnessProps) {
  const [markdown, setMarkdown] = useState(initialMarkdown);

  useEffect(() => {
    useProjectStore.setState({ readOnly: false });
    useDataStore.setState({ activeDatasetId: null, datasets, statusInfo: null });
    useGraphBuilderStore.getState().loadFromProject(graphs);
    useFitYByXStore.getState().loadFromProject(fitYByX);
    useTabulateStore.getState().loadFromProject(tabulates);
  }, [datasets, fitYByX, graphs, tabulates]);

  const graphRuntime = graphMode === "stub"
    ? { render: ({ item, dataset }: Parameters<NonNullable<NonNullable<ReportEmbedRuntime["graph"]>["render"]>>[0]) => <div>{`Graph:${item.name}:${dataset.name}`}</div> }
    : graphMode === "error"
      ? { render: () => { throw new Error("graph exploded"); } }
      : embedRuntime?.graph;

  return (
    <ReportView
      item={{ ...baseItem, markdown, updatedAt: "2026-09-02T10:05:00.000Z" }}
      tableOptions={tableOptions}
      graphOptions={graphOptions}
      fitYByXOptions={fitYByXOptions}
      tabulateOptions={tabulateOptions}
      embedRuntime={{ ...embedRuntime, graph: graphRuntime }}
      onMarkdownChange={setMarkdown}
    />
  );
}

export function ReportEmbedRecoveryHarness() {
  const [recovered, setRecovered] = useState(false);
  const graph = recovered ? { ...defaultGraph, name: "Recovered Graph" } : defaultGraph;

  return (
    <>
      <button type="button" onClick={() => setRecovered(true)}>Recover graph</button>
      <ReportViewHarness
        initialMarkdown={'{{sp-embed kind="graph" id="graph-1"}}'}
        graphs={[graph]}
        graphMode={recovered ? "stub" : "error"}
      />
    </>
  );
}
