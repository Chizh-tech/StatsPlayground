import type {
  DistributionRunStateV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

import "./distribution.css";

interface DistributionWorkspaceProps {
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  runState: DistributionRunStateV1 | null;
}

export function DistributionWorkspace({
  bootstrap,
  runState,
}: DistributionWorkspaceProps) {
  const capabilityCount = bootstrap?.capabilities.length ?? 0;
  const canRun = bootstrap?.canRun === true;
  const percent = runState?.progress?.percent ?? 0;

  return (
    <section className="distribution-workspace" aria-label="Distribution">
      <header className="distribution-header">
        <div>
          <h2>Distribution</h2>
          <p data-testid="distribution-empty-system">
            Statistical methods are not available in this system state.
          </p>
        </div>
        <span className="distribution-count" data-testid="distribution-capability-count">
          {capabilityCount}
        </span>
      </header>
      <div className="distribution-controls">
        <button type="button" disabled={!canRun}>Run</button>
        <button type="button" disabled={!runState || runState.status !== "running"}>Cancel</button>
        <progress max={100} value={percent} aria-label="Progress" />
      </div>
      <div className="distribution-results" data-testid="distribution-results" />
    </section>
  );
}