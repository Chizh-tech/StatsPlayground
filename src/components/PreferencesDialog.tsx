import { useTranslation } from "react-i18next";
import { useThemeStore, ThemeMode } from "@/stores/useThemeStore";
import { useLocaleStore } from "@/stores/useLocaleStore";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n";

interface Props {
  onClose: () => void;
}

export function PreferencesDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeStore();
  const { locale, setLocale } = useLocaleStore();

  const themeOptions: { value: ThemeMode; label: string }[] = [
    { value: "light", label: t("prefs.themeLight") },
    { value: "dark", label: t("prefs.themeDark") },
    { value: "system", label: t("prefs.themeSystem") },
  ];

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div className="sp-dialog sp-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="sp-dialog-title">{t("prefs.title")}</div>
        <div className="sp-dialog-body">
          <label className="sp-dialog-label">{t("prefs.theme")}</label>
          <div className="pref-theme-group">
            {themeOptions.map((opt) => (
              <label key={opt.value} className="pref-theme-option">
                <input
                  type="radio"
                  name="theme"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => setMode(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          <label className="sp-dialog-label" style={{ marginTop: 12 }}>{t("prefs.language")}</label>
          <div className="pref-theme-group">
            {SUPPORTED_LOCALES.map((opt) => (
              <label key={opt.code} className="pref-theme-option">
                <input
                  type="radio"
                  name="locale"
                  value={opt.code}
                  checked={locale === opt.code}
                  onChange={() => setLocale(opt.code as Locale)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            {t("prefs.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
