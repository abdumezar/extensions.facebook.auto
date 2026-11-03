import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { ar } from "./ar.js";
import { en } from "./en.js";

export const LANGS = ["ar", "en"] as const;
export type Lang = (typeof LANGS)[number];

const STORAGE_KEY = "nashir:lang";

export function getSavedLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "en" ? "en" : "ar"; // Arabic-first default
}

export function applyDir(lang: Lang): void {
  const dir = lang === "ar" ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", lang);
}

export async function setLang(lang: Lang): Promise<void> {
  localStorage.setItem(STORAGE_KEY, lang);
  applyDir(lang);
  await i18next.changeLanguage(lang);
}

export async function initI18n(): Promise<void> {
  const lng = getSavedLang();
  applyDir(lng);
  await i18next.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: {
      ar: { translation: ar },
      en: { translation: en },
    },
    interpolation: { escapeValue: false },
  });
}
