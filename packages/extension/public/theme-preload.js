// Pre-paint theme. Generated from themePreloadScript() in
// src/dashboard/lib/theme.ts — scripts/html-preload.test.ts enforces they match.
//
// This lives in public/ and is loaded as a classic <script src>, NOT inlined: MV3
// extension pages run under script-src 'self', which blocks every inline script.
// A classic external script still executes before first paint, so moving it out of
// the HTML costs nothing and the theme still applies with no flash.
(function(){try{var m=localStorage.getItem("nashir:theme")||"system";var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();
