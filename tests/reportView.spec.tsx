import { expect, test } from "@playwright/experimental-ct-react";

import { ReportViewHarness } from "./reportViewHarness";

test("renders markdown editor, GFM preview, and safe HTML handling", async ({ mount }) => {
  const component = await mount(
    <ReportViewHarness initialMarkdown={`# Summary\n\n| Metric | Value |\n| --- | --- |\n| Mean | 7 |\n\n<img src=x onerror="window.__reportXss = true" />`} />,
  );

  await expect(component.getByRole("textbox", { name: "Markdown editor" })).toBeVisible();
  await expect(component.locator(".sp-report-preview h1")).toHaveText("Summary");
  await expect(component.locator(".sp-report-preview table")).toContainText("Metric");
  await expect(component.locator(".sp-report-preview table")).toContainText("Mean");
  await expect(component.locator(".sp-report-preview img")).toHaveCount(0);
});

test("inserts canonical embeds from grouped menu choices", async ({ mount }) => {
  const component = await mount(<ReportViewHarness initialMarkdown={"Summary"} />);
  const editor = component.getByRole("textbox", { name: "Markdown editor" });

  await editor.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  });

  await component.getByRole("button", { name: "Insert" }).click();
  await expect(component.getByText("Tables")).toBeVisible();
  await expect(component.getByText("Graphs")).toBeVisible();
  await expect(component.getByText("Fit Y by X")).toBeVisible();
  await expect(component.getByText("Tabulate")).toBeVisible();

  await component.getByRole("menuitem", { name: "Scatter Plot" }).click();

  await expect(editor).toHaveValue(`Summary\n{{sp-embed kind="graph" id="graph-1"}}`);
  await expect(component.locator(".sp-report-embed-placeholder")).toContainText("Scatter Plot");
});

test("uses a segmented editor or preview mode on narrow viewports", async ({ mount, page }) => {
  await page.setViewportSize({ width: 720, height: 820 });
  const component = await mount(<ReportViewHarness initialMarkdown={"# Compact"} />);

  await expect(component.getByRole("button", { name: "Editor" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(component.getByRole("textbox", { name: "Markdown editor" })).toBeVisible();

  await component.getByRole("button", { name: "Preview" }).click();

  await expect(component.locator(".sp-report-preview h1")).toHaveText("Compact");
  await expect(component.getByRole("textbox", { name: "Markdown editor" })).toBeHidden();
});