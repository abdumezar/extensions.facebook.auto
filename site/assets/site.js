// Fills the download button and release details from the GitHub Releases API.
// The page works without it: the button already links to the latest release page.
(function () {
  "use strict";

  var API = "https://api.github.com/repos/abdumezar/extensions.facebook.auto/releases/latest";
  var DOWNLOAD_PREFIX = "https://github.com/abdumezar/extensions.facebook.auto/releases/download/";
  var TIMEOUT_MS = 8000;

  function setAll(selector, text) {
    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = text;
    });
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      // Western digits in Arabic too, so the date reads the same as the version next to it.
      var lang = document.documentElement.lang || "en";
      var locale = lang === "ar" ? "ar-u-nu-latn" : lang;
      return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(d);
    } catch (e) {
      return iso.slice(0, 10);
    }
  }

  function apply(release) {
    var tag = release && typeof release.tag_name === "string" ? release.tag_name : "";
    var version = tag.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) return;

    var assetName = "nashir-" + version + ".zip";
    var asset = (release.assets || []).filter(function (a) {
      return a && a.name === assetName;
    })[0];
    var url = asset && typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    // Only ever point the button at the project's own release downloads.
    if (url.indexOf(DOWNLOAD_PREFIX) !== 0) return;

    document.querySelectorAll("[data-download]").forEach(function (a) {
      a.setAttribute("href", url);
    });
    setAll("[data-latest-version]", version);
    var date = release.published_at ? formatDate(release.published_at) : "";
    if (date) setAll("[data-latest-date]", date);
    document.querySelectorAll("[data-release-meta]").forEach(function (el) {
      el.hidden = false;
    });
  }

  if (typeof fetch !== "function") return;
  var ctrl = typeof AbortController === "function" ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;

  fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: ctrl ? ctrl.signal : undefined })
    .then(function (res) {
      if (!res.ok) throw new Error("releases " + res.status);
      return res.json();
    })
    .then(apply)
    .catch(function () {
      // Offline, rate-limited or no release yet: keep the static link.
    })
    .then(function () {
      if (timer) clearTimeout(timer);
    });
})();
