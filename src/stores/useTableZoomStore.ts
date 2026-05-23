import { create } from "zustand";

/**
 * Global table zoom preference. Persisted in localStorage so it survives
 * across sessions and projects (zoom is treated as a personal display
 * preference, not a project property).
 *
 * The value is a multiplier: 1.0 = 100%. Used by `DataTableView` to scale
 * row height, column widths, header sizes and font sizes, and consumed by
 * CSS via the `--sp-zoom` custom property on `.sp-spreadsheet`.
 */

const STORAGE_KEY = "sp-table-zoom";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_DEFAULT = 1.0;

/** Snap-to levels used by the zoom-in/zoom-out buttons and shortcuts. */
export const ZOOM_STEPS: readonly number[] = [
  0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0,
];

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function getStoredZoom(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw == null) return ZOOM_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return ZOOM_DEFAULT;
  return clampZoom(n);
}

function persistZoom(z: number) {
  localStorage.setItem(STORAGE_KEY, String(z));
}

/** Find the next step strictly greater than `current`, or `current` if at max. */
function nextStep(current: number): number {
  for (const s of ZOOM_STEPS) if (s > current + 1e-6) return s;
  return ZOOM_MAX;
}

/** Find the previous step strictly less than `current`, or `current` if at min. */
function prevStep(current: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - 1e-6) return ZOOM_STEPS[i];
  }
  return ZOOM_MIN;
}

interface TableZoomState {
  zoom: number;
  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export const useTableZoomStore = create<TableZoomState>((set, get) => ({
  zoom: getStoredZoom(),
  setZoom: (z) => {
    const next = clampZoom(z);
    persistZoom(next);
    set({ zoom: next });
  },
  zoomIn: () => {
    const next = nextStep(get().zoom);
    persistZoom(next);
    set({ zoom: next });
  },
  zoomOut: () => {
    const next = prevStep(get().zoom);
    persistZoom(next);
    set({ zoom: next });
  },
  resetZoom: () => {
    persistZoom(ZOOM_DEFAULT);
    set({ zoom: ZOOM_DEFAULT });
  },
}));
