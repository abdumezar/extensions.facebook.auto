#!/usr/bin/env node
// Regenerates every picture the README and the website use:
//
//   - the dashboard shots, in the languages and themes each place needs
//   - the four install illustrations
//   - the README banner
//
// It starts the harness (a Vite dev server around the real dashboard, fed synthetic
// data), drives a headless Chrome over the DevTools protocol, and stops both. Nothing
// but localhost is contacted.
//
//   pnpm --filter @nashir/extension screenshots [-- --only=<text>] [--chrome=<path>]
//
// `--only` keeps the pictures whose output path contains the text (for example
// `--only=audience` or `--only=docs/`). Chrome is found in its usual install folders;
// set CHROME_PATH or pass `--chrome` for anywhere else.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { stripPngMetadata } from "./optimise.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const HARNESS = "/scripts/screenshots";

/** The dashboard views worth showing, and what has to be on screen before each is drawn. */
const SHOTS = [
  { name: "dashboard", route: "dashboard", wait: "ol li button" },
  { name: "campaign-run", route: "campaign", run: true, wait: "main span.animate-pulse" },
  { name: "audience", route: "audience", wait: "table tbody tr", scrollTo: "main .flex.flex-col.gap-4 > :nth-child(2)" },
  { name: "operations", route: "logs", wait: ".font-mono .flex" },
  { name: "update-banner", route: "dashboard", update: true, wait: 'a[href*="/releases/tag/"]' },
];

/** Language and theme per destination. The Arabic light set is written to two places. */
const SETS = [
  { lang: "ar", theme: "light", dirs: ["site/assets/screenshots", "docs/screenshots/ar"] },
  { lang: "en", theme: "light", dirs: ["site/assets/screenshots/en"] },
  { lang: "en", theme: "dark", dirs: ["docs/screenshots/en"] },
];

const ILLUSTRATIONS = ["unzip", "developer-mode", "load-unpacked", "link-folder"];

const SCREEN = { width: 1600, height: 1000 };
const BANNER = { width: 1280, height: 640 };

/** Everything to draw, as one flat list so `--only` can filter it. */
function listJobs() {
  const jobs = [];
  for (const set of SETS) {
    for (const shot of SHOTS) {
      const query = new URLSearchParams({
        route: shot.route,
        lang: set.lang,
        theme: set.theme,
        run: shot.run ? "1" : "0",
        update: shot.update ? "1" : "0",
      });
      jobs.push({
        page: `${HARNESS}/index.html?${query}`,
        size: SCREEN,
        wait: shot.wait,
        scrollTo: shot.scrollTo,
        outputs: set.dirs.map((dir) => `${dir}/${shot.name}.png`),
      });
    }
  }
  for (const name of ILLUSTRATIONS) {
    jobs.push({
      page: `${HARNESS}/art.html?svg=${name}`,
      size: SCREEN,
      outputs: [`site/assets/screenshots/install-${name}.png`],
    });
  }
  jobs.push({ page: `${HARNESS}/banner.html`, size: BANNER, outputs: ["docs/screenshots/banner.png"] });
  return jobs;
}

// ---------- browser ----------

function findChrome(explicit) {
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(local, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("Chrome was not found. Set CHROME_PATH or pass --chrome=<path>.");
  return found;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Polls `check` until it returns something truthy; fails with `what` after `timeoutMs`. */
async function until(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The few DevTools-protocol calls this script needs, over one WebSocket. */
class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiting = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolveConnect(new Cdp(socket)));
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome")));
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    return new Promise((resolveSend, reject) => {
      this.#pending.set(id, { method, resolve: resolveSend, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.#socket.close();
  }
}

async function launchChrome(executable, profileDir) {
  const stop = new AbortController();
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--lang=en-US",
      "about:blank",
    ],
    { stdio: "ignore", signal: stop.signal },
  );
  // Aborting the signal ends the process and is reported here, which is expected.
  child.on("error", () => {});
  try {
    const portFile = join(profileDir, "DevToolsActivePort");
    const [port, path] = (
      await until(async () => (existsSync(portFile) ? (await readFile(portFile, "utf8")).trim() : ""), "Chrome to start")
    ).split("\n");
    return { child, stop, cdp: await Cdp.connect(`ws://127.0.0.1:${port}${path}`) };
  } catch (error) {
    stop.abort();
    throw error;
  }
}

/** Asks Chrome to quit and waits for it to, so its profile folder can be removed. */
async function closeChrome({ child, cdp, stop }) {
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  await cdp.send("Browser.close").catch(() => {});
  cdp.close();
  await Promise.race([exited, sleep(5000)]);
  // Ends it for good if it ignored the request.
  stop.abort();
}

/** One page, one picture: open it, wait until it says it is ready, capture the viewport. */
async function shoot(cdp, baseUrl, job) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const { result } = await call("Runtime.evaluate", { expression, returnByValue: true });
    return result.value;
  };

  try {
    await call("Emulation.setDeviceMetricsOverride", {
      width: job.size.width,
      height: job.size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The harness stops its clock at a fixed moment; the time zone has to be fixed too.
    await call("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await call("Page.navigate", { url: baseUrl + job.page });

    const selector = JSON.stringify(job.wait ?? "body");
    await until(
      () =>
        evaluate(
          `document.documentElement.dataset.ready === "1" && !document.querySelector('[aria-busy="true"]') && !!document.querySelector(${selector})`,
        ),
      `${job.page} to be ready`,
    );
    // Brings a card's top edge to just under the sticky header, so no line of text is
    // left half hidden behind it.
    if (job.scrollTo) {
      await evaluate(
        `(() => { const main = document.querySelector("main"); main.scrollTop += document.querySelector(${JSON.stringify(job.scrollTo)}).getBoundingClientRect().top - 80; })()`,
      );
    }
    await sleep(400);

    const { data } = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
    return Buffer.from(data, "base64");
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---------- main ----------

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function option(name) {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag?.slice(name.length + 3);
}

async function main() {
  const only = option("only");
  const jobs = listJobs()
    .map((job) => ({ ...job, outputs: job.outputs.filter((out) => !only || out.includes(only)) }))
    .filter((job) => job.outputs.length > 0);
  if (jobs.length === 0) throw new Error(`Nothing matches --only=${only}`);

  const chrome = findChrome(option("chrome"));
  const profileDir = await mkdtemp(join(tmpdir(), "nashir-shots-"));
  const port = await freePort();
  const server = await createServer({
    configFile: join(here, "vite.config.mjs"),
    server: { port, strictPort: true },
    logLevel: "warn",
  });
  let browser;

  try {
    await server.listen();
    browser = await launchChrome(chrome, profileDir);
    const baseUrl = `http://127.0.0.1:${port}`;

    for (const job of jobs) {
      const png = stripPngMetadata(await shoot(browser.cdp, baseUrl, job));
      for (const output of job.outputs) {
        const target = join(repoRoot, output);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, png);
        console.log(`${output}  ${(png.length / 1024).toFixed(0)} KB`);
      }
    }
  } finally {
    if (browser) await closeChrome(browser);
    await server.close();
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
