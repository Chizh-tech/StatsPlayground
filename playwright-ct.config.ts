import { defineConfig, devices } from "@playwright/experimental-ct-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.tsx$/,
  timeout: 30_000,
  fullyParallel: false,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 820 },
    ctViteConfig: {
      resolve: {
        alias: {
          "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
      },
    },
  },
});