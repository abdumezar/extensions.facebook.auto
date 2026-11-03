import i18next, { type i18n } from "i18next";
import { ar } from "../dashboard/i18n/ar.js";
import { en } from "../dashboard/i18n/en.js";

/**
 * A private i18next instance with the real bundles, for tests that assert on rendered copy.
 *
 * Hand it to `<I18nextProvider>`. It is deliberately not registered with react-i18next's
 * global slot, so suites that rely on `t` echoing the key (they render without a provider)
 * behave the same whatever order the tests in a file run in.
 */
export async function createTestI18n(lng: "en" | "ar" = "en"): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, ar: { translation: ar } },
    interpolation: { escapeValue: false },
  });
  return instance;
}
