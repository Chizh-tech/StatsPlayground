# Task 6 Report: Markdown Editor, Preview, And Insertion

## Status
- Complete

## Commit
- `d4c4c82` — `feat(report): add markdown editor and preview`
- Pending cleanup commit to remove accidentally staged Playwright `.cache` artifacts and add an ignore rule.

## Files
- `package.json`
- `package-lock.json`
- `playwright-ct.config.ts`
- `playwright/index.tsx`
- `playwright/index.html`
- `src/components/Workspace.tsx`
- `src/components/report/ReportView.tsx`
- `src/components/report/ReportMarkdown.tsx`
- `src/components/report/report.css`
- `src/i18n/locales/en.json`
- `src/i18n/locales/vi.json`
- `src/i18n/locales/zh-CN.json`
- `src/i18n/locales/zh-TW.json`
- `tests/reportEditor.test.ts`
- `tests/reportView.spec.tsx`
- `tests/reportViewHarness.tsx`

## TDD Evidence

### Step 1: Required dependencies installed
Command:
`npm install react-markdown remark-gfm`

Result:
- Installed the required markdown rendering dependencies.

Additional test infrastructure needed because this issue worktree did not include Playwright CT setup:
`npm install -D @playwright/experimental-ct-react playwright`

### Step 2: Pure helper RED
Command:
`npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts`

Result:
- `ERR_MODULE_NOT_FOUND` for `src/components/report/ReportMarkdown.tsx`.

### Step 3: Pure helper GREEN
Command:
`npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts`

Result:
- `report editor contract passed`

Notable local repair during GREEN:
- The first implementation left the caret before an existing trailing CRLF, which would let the next typed character break the standalone embed line. I corrected the helper to advance past the existing line break when that line break is the post-embed separator.

### Step 4: Component spec RED
Initial infrastructure blocker:
- `npx playwright test tests/reportView.spec.tsx --config playwright-ct.config.ts` first failed because Chromium was not installed yet.
- Fixed by running `npx playwright install chromium`.

Meaningful RED after browser setup:
`npx playwright test tests/reportView.spec.tsx --config playwright-ct.config.ts`

Result:
- The spec failed because `ReportView` still rendered only the placeholder surface and did not expose the required editor, insert menu, or narrow-view segmented control.

One test-only repair before UI work:
- Playwright CT rejected an inline harness component defined inside the spec file, so I moved it into `tests/reportViewHarness.tsx` and reran the same spec to keep the RED signal about `ReportView` itself.

### Step 5: Component spec GREEN
Command:
`npx playwright test tests/reportView.spec.tsx --config playwright-ct.config.ts`

Result:
- `3 passed`

Covered behaviors:
- Desktop editor + live preview render.
- GFM heading/table rendering.
- Raw HTML does not execute.
- Insert menu groups Tables / Graphs / Fit Y by X / Tabulate and inserts the canonical directive.
- Narrow viewport switches between Editor and Preview through a segmented control.

### Step 6: Required final verification
Command:
`npx tsx --tsconfig tsconfig.app.json tests/reportEditor.test.ts`

Result:
- `report editor contract passed`

Command:
`npx playwright test tests/reportView.spec.tsx --config playwright-ct.config.ts`

Result:
- `3 passed`

Command:
`npx vite build`

Result:
- Exit `0`
- Build succeeded.
- Vite reported pre-existing chunk-size and dynamic-import warnings, but no build failure.

Command:
`git diff --check`

Result:
- No output.

## Design Decisions
- `insertReportEmbed` is a pure helper that always emits the canonical Task 1 directive via `formatReportEmbed` and normalizes the insertion so the embed occupies a standalone line.
- `Workspace` owns the report-edit boundary: `useReportStore.updateMarkdown` fires immediately on every change, while history entries are debounced and coalesced at the workspace layer so typing does not spam the history timeline.
- `ReportMarkdown` uses `react-markdown` with `remark-gfm` and explicitly avoids `rehypeRaw`; raw HTML is skipped rather than executed.
- Report embeds intentionally render as clear placeholders that name the referenced document. No live adapters, workflow rendering, or Distribution-specific behavior were added.
- Desktop uses a stable two-pane split. Narrow view collapses to an Editor/Preview segmented switch instead of stacking decorative cards.

## Self-Review
- The editor is fully controlled by the current `ReportItem`, so preview and textarea stay in sync with immediate store updates.
- Inserted embeds restore focus and caret position after React re-renders, including CRLF documents.
- The UI stays inside existing workspace conventions: shared panel headers, Font Awesome icons, restrained toolbar styling, and i18n-backed labels.
- The implementation remains scoped to Task 6 and does not introduce live embed execution, workflow surfaces, or Distribution changes.

## Concerns
- This issue worktree was missing Playwright component-test setup, so Task 6 needed a small CT harness addition (`playwright-ct.config.ts`, `playwright/`, and a test harness component) to satisfy the required UI RED/GREEN cycle.
- `npx vite build` still reports large-chunk and `dataService` dynamic-import warnings that predate this task; they were not changed here.
- I initially committed generated `playwright/.cache` artifacts by staging the whole `playwright/` directory. I corrected that by ignoring `playwright/.cache/`, removing those files from version control, and re-running the required checks before the final cleanup commit.