import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CustomPalette } from "@/stores/useGraphPaletteStore";

interface Props {
  onSave: (palette: Omit<CustomPalette, "id">) => void;
  onClose: () => void;
}

/**
 * Local copy of `shade()` from GraphBuilderView. Duplicated (rather than
 * imported) so this dialog file doesn't create a circular import with its
 * parent (`GraphBuilderView.tsx` imports this dialog; this dialog would
 * otherwise import back from it). The function is tiny.
 *
 * `ratio` in [-1, 1]: negative mixes `hex` toward black, positive toward
 * white. Same math as the master copy so previews match the chart pixel
 * for pixel.
 */
function shadeHex(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const hh = m[1];
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  const mix = (c: number) =>
    ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio);
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/**
 * Perceptual luminance (Rec. 601 weights). We use this to reject Point
 * colors that are so close to white that the derived Line / Fill shades
 * collapse toward pure white and become indistinguishable on the chart.
 */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const hh = m[1];
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Auto-derive ratios. The user picks Point (the darkest mark); we mix
 * toward white twice to land on Line (mid) and Fill (lightest). Ratios
 * were chosen so the three shades stay visually distinct *and* land in
 * roughly the same brightness band as the built-in `STYLE_COLORS` trio.
 */
const AUTO_DERIVE_LINE_RATIO = 0.30;
const AUTO_DERIVE_FILL_RATIO = 0.70;

/**
 * Above this luminance the derived Fill shade is essentially #ffffff,
 * which is invisible on the (typically white) chart canvas. We block
 * Save in auto mode and show a hint asking the user to pick a darker
 * Point color. Manual mode skips this check — power users can opt into
 * pale palettes if they really want them.
 */
const AUTO_DERIVE_MAX_LUMINANCE = 0.78;

export function AddPaletteDialog({ onSave, onClose }: Props) {
  const { t } = useTranslation();

  // Two design modes — see the file header comment block for rationale.
  const [mode, setMode] = useState<"auto" | "manual">("auto");

  // Auto mode: one color → three derived shades.
  const [autoPoint, setAutoPoint] = useState("#3b569e");
  const autoDerived = useMemo(
    () => ({
      line: shadeHex(autoPoint, AUTO_DERIVE_LINE_RATIO),
      fill: shadeHex(autoPoint, AUTO_DERIVE_FILL_RATIO),
    }),
    [autoPoint],
  );
  const autoTooLight = luminance(autoPoint) > AUTO_DERIVE_MAX_LUMINANCE;

  // Manual mode: independent Point / Line / Fill pickers. Seeded with a
  // balanced default (a built-in indigo trio) so first-time users see a
  // sensible preview rather than three identical black squares.
  const [manPoint, setManPoint] = useState("#3b569e");
  const [manLine, setManLine] = useState("#4a6cf7");
  const [manFill, setManFill] = useState("#a0b3fa");

  const handleSave = () => {
    if (mode === "auto") {
      if (autoTooLight) return;
      onSave({
        mode: "auto",
        point: autoPoint,
        line: autoDerived.line,
        fill: autoDerived.fill,
      });
    } else {
      onSave({
        mode: "manual",
        point: manPoint,
        line: manLine,
        fill: manFill,
      });
    }
    onClose();
  };

  // Vertical 3-band gradient: Fill (top) → Line (mid) → Point (bottom).
  // Identical layout to the swatches inside the legend Theme picker so
  // the preview here matches what users will see after Save.
  const previewBg = (p: string, l: string, f: string) =>
    `linear-gradient(180deg, ${f} 0 33%, ${l} 33% 67%, ${p} 67% 100%)`;

  const saveDisabled = mode === "auto" && autoTooLight;

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div
        className="sp-dialog gb-theme-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">
          {t("graph.style.themeDialog.title")}
        </div>
        <div className="sp-dialog-body">
          <div className="gb-theme-mode-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "auto"}
              className={`gb-theme-mode-tab${mode === "auto" ? " gb-theme-mode-tab-active" : ""}`}
              onClick={() => setMode("auto")}
            >
              {t("graph.style.themeDialog.modeAuto")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "manual"}
              className={`gb-theme-mode-tab${mode === "manual" ? " gb-theme-mode-tab-active" : ""}`}
              onClick={() => setMode("manual")}
            >
              {t("graph.style.themeDialog.modeManual")}
            </button>
          </div>

          {mode === "auto" ? (
            <>
              <div className="gb-theme-mode-hint">
                {t("graph.style.themeDialog.modeAutoHint")}
              </div>
              <label className="sp-dialog-label">
                {t("graph.style.themeDialog.basePoint")}
              </label>
              <div className="gb-theme-color-row">
                <input
                  type="color"
                  className="gb-theme-color-input"
                  value={autoPoint}
                  onChange={(e) => setAutoPoint(e.target.value)}
                />
                <span className="gb-theme-hex">{autoPoint.toUpperCase()}</span>
              </div>
              <label className="sp-dialog-label">
                {t("graph.style.themeDialog.preview")}
              </label>
              <div
                className="gb-theme-preview"
                style={{
                  background: previewBg(autoPoint, autoDerived.line, autoDerived.fill),
                }}
                title={`${autoDerived.fill} / ${autoDerived.line} / ${autoPoint}`}
              />
              {autoTooLight && (
                <div className="sp-dialog-error">
                  {t("graph.style.themeDialog.tooLight")}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="gb-theme-mode-hint">
                {t("graph.style.themeDialog.modeManualHint")}
              </div>
              <label className="sp-dialog-label">{t("graph.mark.point")}</label>
              <div className="gb-theme-color-row">
                <input
                  type="color"
                  className="gb-theme-color-input"
                  value={manPoint}
                  onChange={(e) => setManPoint(e.target.value)}
                />
                <span className="gb-theme-hex">{manPoint.toUpperCase()}</span>
              </div>
              <label className="sp-dialog-label">{t("graph.mark.line")}</label>
              <div className="gb-theme-color-row">
                <input
                  type="color"
                  className="gb-theme-color-input"
                  value={manLine}
                  onChange={(e) => setManLine(e.target.value)}
                />
                <span className="gb-theme-hex">{manLine.toUpperCase()}</span>
              </div>
              <label className="sp-dialog-label">{t("graph.mark.fill")}</label>
              <div className="gb-theme-color-row">
                <input
                  type="color"
                  className="gb-theme-color-input"
                  value={manFill}
                  onChange={(e) => setManFill(e.target.value)}
                />
                <span className="gb-theme-hex">{manFill.toUpperCase()}</span>
              </div>
              <label className="sp-dialog-label">
                {t("graph.style.themeDialog.preview")}
              </label>
              <div
                className="gb-theme-preview"
                style={{ background: previewBg(manPoint, manLine, manFill) }}
                title={`${manFill} / ${manLine} / ${manPoint}`}
              />
            </>
          )}
        </div>
        <div className="sp-dialog-actions">
          <button type="button" className="sp-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="sp-dialog-btn sp-dialog-btn-primary"
            onClick={handleSave}
            disabled={saveDisabled}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
