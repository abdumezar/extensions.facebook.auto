import logoEn from "../assets/logos/logo-en.png";

// Bundled fonts + the M3 token layer. The popup shares the extension origin
// with the dashboard, so it reads the same theme and language keys.
import "../assets/fonts/fonts.css";
import "../dashboard/tokens.css";

/** Popup: open (or focus) the single-instance dashboard tab, then close the popup. */
async function openDashboard() {
  await chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  window.close();
}

// The dashboard and the popup share the extension origin, so they share localStorage —
// mirror the saved language here. Arabic (the markup default) is the fallback.
function applyLang() {
  if (localStorage.getItem("nashir:lang") !== "en") return;
  document.documentElement.setAttribute("lang", "en");
  document.documentElement.setAttribute("dir", "ltr");
  const logo = document.getElementById("logo") as HTMLImageElement | null;
  if (logo) logo.src = logoEn;
  const btn = document.getElementById("open");
  if (btn) btn.textContent = "Open dashboard";
}

applyLang();

document.getElementById("open")?.addEventListener("click", () => void openDashboard());

// Auto-open on popup show — the popup is just a launcher.
void openDashboard();
