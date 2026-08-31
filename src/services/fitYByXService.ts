import { invoke } from "@tauri-apps/api/core";

import type { FitYByXRequest, FitYByXResult } from "@/types/fitYByX";

export const fitYByXService = {
  run: (request: FitYByXRequest) =>
    invoke<FitYByXResult>("fit_y_by_x", { request }),
};