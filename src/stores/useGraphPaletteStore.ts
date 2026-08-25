import { create } from "zustand";
import { useProjectStore } from "@/stores/useProjectStore";
import { assertProjectMutable } from "@/utils/saveReadOnly";

/**
 * A user-defined color theme that appears alongside the built-in
 * `STYLE_COLORS` palette inside the Graph Builder's legend Theme picker.
 *
 * We store the *final* per-mark colors (not a base + shading formula) so
 * what's saved is exactly what gets applied — future changes to the
 * SHADE_RATIO_* constants won't silently re-color a user's saved themes.
 */
export interface CustomPalette {
  id: string;
  /**
   * "auto":   derived from a single Point color via lighter Line / Fill
   *           shades. `point` is what the user picked; `line` / `fill`
   *           are computed from it at save time.
   * "manual": user picked Point / Line / Fill independently.
   */
  mode: "auto" | "manual";
  point: string;
  line: string;
  fill: string;
}

interface GraphPaletteState {
  palettes: CustomPalette[];
  addPalette: (p: Omit<CustomPalette, "id">) => string;
  removePalette: (id: string) => void;
}

const STORAGE_KEY = "sp-graph-palettes";

function load(): CustomPalette[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is CustomPalette =>
        x
        && typeof x.id === "string"
        && (x.mode === "auto" || x.mode === "manual")
        && typeof x.point === "string"
        && typeof x.line === "string"
        && typeof x.fill === "string",
    );
  } catch {
    return [];
  }
}

function save(palettes: CustomPalette[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(palettes));
  } catch {
    // localStorage full or disabled — silently ignore; the user can keep
    // using the theme this session and re-create it next launch.
  }
}

function newId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useGraphPaletteStore = create<GraphPaletteState>((set) => ({
  palettes: load(),
  addPalette: (p) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const id = newId();
    set((s) => {
      const next = [...s.palettes, { ...p, id }];
      save(next);
      return { palettes: next };
    });
    return id;
  },
  removePalette: (id) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((s) => {
        const next = s.palettes.filter((p) => p.id !== id);
        save(next);
        return { palettes: next };
      });
    },
}));
