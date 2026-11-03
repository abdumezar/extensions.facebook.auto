// Mounts the real dashboard against the fake `chrome` from fakeChrome.js.
//
//   index.html?route=dashboard|campaign|audience|logs|settings
//             &lang=ar|en  &theme=light|dark  &run=0|1  &update=0|1
//
// When the page is drawn and its data has arrived, `<html data-ready="1">` is set;
// capture.mjs waits for that before taking the picture.

import { scenario, seed } from "./fakeChrome.js";
import { fontsLoaded } from "./fonts.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/dashboard/App";
import { initI18n } from "../../src/dashboard/i18n/index";
import { initTheme } from "../../src/dashboard/lib/theme";
import { useStore } from "../../src/dashboard/store";

import "../../src/assets/fonts/fonts.css";
import "../../src/dashboard/tokens.css";
import "../../src/dashboard/styles.css";

/** The query-string names of the views, where they differ from the store's. */
const VIEW_BY_ROUTE = { campaign: "content" };

/** A frozen frame is a reproducible one: no transitions or pulses caught half way, no blinking caret. */
function freezeMotion() {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }";
  document.head.append(style);
}

/** Resolves once the store holds the session and the group list, or after `ms`. */
function whenLoaded(ms) {
  return new Promise((resolve) => {
    const done = () => {
      const state = useStore.getState();
      return state.session !== null && state.groups.length > 0;
    };
    if (done()) return resolve();
    const stop = useStore.subscribe(() => {
      if (done()) {
        stop();
        resolve();
      }
    });
    setTimeout(resolve, ms);
  });
}

async function boot() {
  // Read by the dashboard's own initialisers, exactly as in the extension.
  localStorage.setItem("nashir:lang", scenario.lang);
  localStorage.setItem("nashir:theme", scenario.theme);
  // The audience page is a consent screen until this is set.
  localStorage.setItem("nashir:audience-consent", "1");

  freezeMotion();
  initTheme();
  await initI18n();

  const store = useStore.getState();
  store.setView(VIEW_BY_ROUTE[scenario.route] ?? scenario.route);
  store.updateDraft(seed.draft);
  store.setSelectedGroups(seed.selectedGroupIds);

  createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode, null, React.createElement(App)));

  await whenLoaded(10_000);
  await fontsLoaded();
  document.documentElement.dataset.ready = "1";
}

void boot();
