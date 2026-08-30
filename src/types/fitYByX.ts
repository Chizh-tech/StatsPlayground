import type { FieldRef } from "@/graphCore";

import type { EmbeddedGraphConfig } from "./graphBuilder";

export interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}