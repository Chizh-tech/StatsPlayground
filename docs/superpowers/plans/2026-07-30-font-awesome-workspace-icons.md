# Font Awesome Workspace Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace six workspace inline SVG icons with the requested Font Awesome Solid icons while preserving all existing colors and interactions.

**Architecture:** Bundle the official Font Awesome Free package with the Vite frontend by importing its CSS once in the application entry point. Replace only the six target SVG elements in the workspace component; existing CSS continues to supply color through inheritance.

**Tech Stack:** React 19, TypeScript, Vite 6, Font Awesome Free

---

### Task 1: Bundle Font Awesome

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main.tsx`

- [ ] **Step 1: Install the official package**

Run:

```powershell
npm install @fortawesome/fontawesome-free
```

Expected: npm exits with code 0 and records `@fortawesome/fontawesome-free` in dependencies.

- [ ] **Step 2: Import the bundled stylesheet**

Add this third-party import before local application imports in `src/main.tsx`:

```ts
import "@fortawesome/fontawesome-free/css/all.min.css";
```

- [ ] **Step 3: Verify package and stylesheet resolution**

Run:

```powershell
npm ls @fortawesome/fontawesome-free
```

Expected: the dependency tree contains one resolved `@fortawesome/fontawesome-free` version and exits with code 0.

### Task 2: Replace the Workspace Icons

**Files:**
- Modify: `src/components/Workspace.tsx`

- [ ] **Step 1: Replace only the six requested SVG elements**

Use these JSX elements in the existing SVG positions without inline color styles:

```tsx
<i className="fa-solid fa-floppy-disk" aria-hidden="true" />
<i className="fa-solid fa-folder-plus" aria-hidden="true" />
<i className="fa-solid fa-down-left-and-up-right-to-center" aria-hidden="true" />
<i className="ds-icon fa-solid fa-folder" aria-hidden="true" />
<i className="ds-icon fa-solid fa-table" aria-hidden="true" />
<i className="ds-icon fa-solid fa-chart-pie" aria-hidden="true" />
```

Preserve the current save button, new-folder button, collapse-all button, folder row, table row, and Graph Builder row event handlers and labels. Leave snapshot, activity bar, history, and folder-chevron SVGs unchanged.

- [ ] **Step 2: Preserve existing rendered sizes**

Add only size-specific classes or inline dimensions if Font Awesome's glyph dimensions differ materially from the replaced `14px` and `20px` SVG boxes. Do not add a color declaration; each icon must inherit the existing `color` value.

### Task 3: Validate the Frontend Bundle

**Files:**
- Verify: `src/main.tsx`
- Verify: `src/components/Workspace.tsx`

- [ ] **Step 1: Run the frontend build**

Run:

```powershell
npx vite build 2>&1 | Select-Object -Last 3
```

Expected: Vite reports a successful production build with no TypeScript or asset-resolution errors.

- [ ] **Step 2: Confirm bundled font assets**

Run:

```powershell
Get-ChildItem dist/assets -File | Where-Object { $_.Extension -in ".woff2", ".woff", ".ttf" } | Select-Object -ExpandProperty Name
```

Expected: at least one Font Awesome webfont asset is listed, confirming offline bundling.