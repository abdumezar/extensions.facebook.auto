import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initI18n } from "./i18n/index.js";
import { initTheme } from "./lib/theme.js";

// Import order is the cascade order, so it is stated here rather than left to how
// the bundler resolves @import: fonts, then the M3 token layer, then everything
// that consumes the tokens.
import "../assets/fonts/fonts.css";
import "./tokens.css";
import "./styles.css";

async function boot() {
  // The pre-paint script in index.html already set the class; this re-applies it
  // and subscribes to OS scheme changes for the life of the page.
  initTheme();
  await initI18n();
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
