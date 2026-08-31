import type { FieldRef } from "@/graphCore";

import type { EmbeddedGraphConfig } from "./graphBuilder";

export type FitYByXPersonality = "oneway" | "bivariate";

export interface FitYByXItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  personality: FitYByXPersonality;
  graph: EmbeddedGraphConfig;
  createdAt: string;
}