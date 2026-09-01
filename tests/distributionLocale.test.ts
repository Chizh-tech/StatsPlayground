import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const localePaths = ["en", "zh-CN", "zh-TW", "vi"] as const;
const requiredKeys = [
  "title",
  "recall",
  "searchColumns",
  "sourceDataset",
  "confidenceLevel",
  "frequencyShort",
  "histogramsOnly",
  "invalidConfig",
  "runDisabledHint",
  "saving",
  "run",
  "roleLabel",
  "roleEmpty",
  "assignToRole",
  "removeFromRole",
] as const;

for (const locale of localePaths) {
  const messages = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const distribution = messages.distribution as Record<string, unknown> | undefined;

  assert.ok(distribution, `${locale} must define the distribution namespace`);
  for (const key of requiredKeys) {
    assert.equal(typeof distribution[key], "string", `${locale} distribution.${key}`);
  }

  const roles = distribution.roles as Record<string, unknown> | undefined;
  assert.ok(roles, `${locale} must define distribution.roles`);
  for (const role of ["y", "weight", "frequency", "by"] as const) {
    assert.equal(typeof roles[role], "string", `${locale} distribution.roles.${role}`);
  }

  const specification = distribution.specification as Record<string, unknown> | undefined;
  assert.equal(
    typeof specification?.useOverride,
    "string",
    `${locale} distribution.specification.useOverride`,
  );
}