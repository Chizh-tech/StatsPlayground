import { invoke } from "@tauri-apps/api/core";

import type { FitModelRequest, FitModelResult } from "@/types/fitModel";

export const fitModelService = {
  run: (request: FitModelRequest) =>
    invoke<FitModelResult>("fit_model", { request }),
};
