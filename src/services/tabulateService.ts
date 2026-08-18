import { invoke } from "@tauri-apps/api/core";
import type { TabulateRequest, TabulateResult } from "@/types/tabulate";

export const tabulateService = {
  run: (request: TabulateRequest) =>
    invoke<TabulateResult>("tabulate", { request }),
};