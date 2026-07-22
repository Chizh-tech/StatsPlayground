---
mode: agent
description: 'Build distributable StatsPlayground installers with cargo tauri build and report the produced artifacts per platform.'
---

# Release Build

Produce distributable installers for StatsPlayground and verify the artifacts.

## Steps
1. **Preflight** — confirm the tree is clean and on the intended branch:
   `git status --short` and `git branch --show-current`. Confirm
   `version` in [package.json](../../package.json) and
   [src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json) match; if a
   version bump is intended, update both.
2. **Build the frontend** to catch TS/bundle errors fast:
   `npx vite build 2>&1 | Select-Object -Last 5`
3. **Backend sanity** (in `src-tauri/`): `cargo clippy -- -D warnings` then
   `cargo test`.
4. **Produce installers**: `cargo tauri build`
5. **Report artifacts** produced under `src-tauri/target/release/bundle/`,
   matched to the current OS:

   | Platform | Formats |
   |----------|---------|
   | Windows  | `.msi` / `.exe` (NSIS) |
   | macOS    | `.dmg` / `.app` |
   | Linux    | `.deb` / `.AppImage` |

   List the actual files found and their paths.

## Notes
- `cargo tauri build` only produces installers for the host OS. Cross-platform
  releases go through the GitHub Actions matrix
  (`windows-latest`, `macos-latest`, `ubuntu-latest`).
- Do NOT push tags or publish a release unless explicitly asked.
- If the build fails, diagnose from the last error lines rather than re-running
  blindly.
