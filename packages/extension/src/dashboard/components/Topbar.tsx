import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store.js";
import { getSavedLang, setLang } from "../i18n/index.js";
import { getSavedTheme, setTheme, type ThemeMode } from "../lib/theme.js";
import { IconButton, type IconName } from "../ui/index.js";

/** Cycles system -> light -> dark -> system, so one control covers all three modes. */
const NEXT: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_ICON: Record<ThemeMode, IconName> = {
  system: "contrast",
  light: "light_mode",
  dark: "dark_mode",
};

const THEME_LABEL: Record<ThemeMode, string> = {
  system: "common.themeSystem",
  light: "common.themeLight",
  dark: "common.themeDark",
};

/** M3 small top app bar. */
export function Topbar() {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const lang = getSavedLang();

  // Mirrors the stored preference so the icon re-renders on change; the source of
  // truth stays in localStorage, shared with the popup.
  const [theme, setThemeState] = useState<ThemeMode>("system");
  useEffect(() => setThemeState(getSavedTheme()), []);

  function cycleTheme() {
    const next = NEXT[theme];
    setTheme(next);
    setThemeState(next);
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 bg-surface px-6">
      <h1 className="truncate text-title-large text-on-surface">{t(`nav.${view}`)}</h1>

      <div className="flex items-center gap-1">
        <IconButton
          icon={THEME_ICON[theme]}
          label={`${t("common.theme")}: ${t(THEME_LABEL[theme])}`}
          onClick={cycleTheme}
        />
        <IconButton
          icon="translate"
          label={t("common.language")}
          onClick={() => void setLang(lang === "ar" ? "en" : "ar")}
        />
      </div>
    </header>
  );
}
