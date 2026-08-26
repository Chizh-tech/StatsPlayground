import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionWorkspace } from "../../src/components/distribution";

test("renders the dormant empty-system statistical shell", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      bootstrap={{
        schemaVersion: "1",
        mode: "emptySystem",
        canRun: false,
        datasetCount: 0,
        capabilities: [],
        observationPolicy: { schemaVersion: "1", dimensions: [] },
        resourceBudget: {
          maxGroups: 1000,
          maxRowsPerGroup: 100000,
          maxTotalRows: 1000000,
          maxTotalBytes: 67108864,
          cancelToken: null,
        },
      }}
      runState={null}
    />,
  );
  await expect(component.getByTestId("distribution-empty-system")).toBeVisible();
  await expect(component.getByTestId("distribution-capability-count")).toHaveText("0");
  await expect(component.getByTestId("distribution-results")).toBeEmpty();
  await expect(component.getByRole("button", { name: "Run" })).toBeDisabled();
  await expect(component.locator("canvas")).toHaveCount(0);
});