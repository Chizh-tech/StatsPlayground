import { invoke } from "@tauri-apps/api/core";

import type {
  BlackBoxCaseV1,
  CapabilityDescriptorV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

export const distributionService = {
  bootstrapWorkspace: () =>
    invoke<DistributionWorkspaceBootstrapV1>("bootstrap_distribution_workspace"),
  listCapabilities: () =>
    invoke<CapabilityDescriptorV1[]>("list_distribution_capabilities"),
  validateBlackBoxCase: (caseDefinition: BlackBoxCaseV1) =>
    invoke<void>("validate_black_box_case", { case: caseDefinition }),
};