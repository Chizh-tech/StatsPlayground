import { invoke } from "@tauri-apps/api/core";

import type {
  BlackBoxCaseV1,
  CapabilityDescriptorV1,
  DistributionCancelTokenV1,
  DistributionRequestV1,
  DistributionResultEnvelopeV1,
  DistributionRunAcceptedV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

export const distributionService = {
  bootstrapWorkspace: () =>
    invoke<DistributionWorkspaceBootstrapV1>("bootstrap_distribution_workspace"),
  listCapabilities: () =>
    invoke<CapabilityDescriptorV1[]>("list_distribution_capabilities"),
  validateBlackBoxCase: (caseDefinition: BlackBoxCaseV1) =>
    invoke<void>("validate_black_box_case", { case: caseDefinition }),
  startRun: (request: DistributionRequestV1) =>
    invoke<DistributionRunAcceptedV1>("start_distribution_run", { request }),
  executeRun: (request: DistributionRequestV1, accepted: DistributionRunAcceptedV1) =>
    invoke<DistributionResultEnvelopeV1>("execute_distribution_run", { request, accepted }),
  cancelRun: (token: DistributionCancelTokenV1) =>
    invoke<void>("cancel_distribution_run", { token }),
};