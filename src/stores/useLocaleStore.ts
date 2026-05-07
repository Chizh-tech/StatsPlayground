import { create } from "zustand";
import i18n, { getStoredLocale, persistLocale, type Locale } from "@/i18n";

interface LocaleState {
  locale: Locale;
  setLocale: (loc: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: getStoredLocale(),
  setLocale: (loc) => {
    persistLocale(loc);
    void i18n.changeLanguage(loc);
    set({ locale: loc });
  },
}));
