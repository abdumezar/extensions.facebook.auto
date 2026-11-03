/**
 * End-to-end proof of the update flow, without publishing anything.
 *
 *   node packages/extension/scripts/e2e-update.mjs              build, sign, serve, print the steps
 *   node packages/extension/scripts/e2e-update.mjs --dry-run    build, sign, verify; no server
 *   node packages/extension/scripts/e2e-update.mjs --port 8123  serve on a fixed port
 *
 * What it does:
 *   1. Makes a throwaway ed25519 key pair in memory. The private half is never written to
 *      disk and the public half only ever reaches the two test builds.
 *   2. Builds version 1.0.0 into e2e/v1 (`vite build --mode e2e`): the build you load in
 *      Chrome. It trusts the throwaway key and asks the local releases address below.
 *   3. Builds 1.0.1, packs it exactly as `pnpm pack:ext` does, and signs the zip.
 *   4. Serves `releases/latest` and the two assets on 127.0.0.1 until you press Ctrl+C.
 *
 * Everything lands in e2e/, which is git-ignored. The throwaway key only exists in these
 * two builds, so a signature made here is worthless to a normal install.
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packRelease } from "./pack.mjs";
import { signFile, verifyWithRawKey } from "./sign-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E = join(ROOT, "e2e");
const FILE_LIST = "nashir-files.json";
const MARKER = "NASHIR_E2E_BUILD";
const FIRST_VERSION = "1.0.0";
const NEXT_VERSION = "1.0.1";
/** In version 1 only, so the update has a stale file to remove. */
const STALE_FILE = "e2e-only-in-v1.txt";
/** Used by --dry-run, which never listens; the API address is baked into the builds. */
const DRY_RUN_PORT = 45871;

/** The throwaway key pair. `pubKey` is the raw 32-byte public key in base64. */
function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubKey: spki.subarray(spki.length - 32).toString("base64"),
  };
}

/** Builds the extension in e2e mode at `version` into `outDir`. */
async function buildVersion({ version, outDir, pubKey, api }) {
  const { build } = await import("vite");
  const env = { NASHIR_E2E_VERSION: version, NASHIR_E2E_PUBKEY: pubKey, NASHIR_E2E_API: api };
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    await build({
      root: ROOT,
      configFile: join(ROOT, "vite.config.ts"),
      mode: "e2e",
      logLevel: "warn",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

/** Writes `nashir-files.json` the way the packer does, so the folder looks like an installed release. */
async function writeFileList(dir) {
  const names = [...(await listFiles(dir)).filter((name) => name !== FILE_LIST), FILE_LIST].sort();
  await writeFile(join(dir, FILE_LIST), JSON.stringify(names, null, 2) + "\n");
  return names;
}

async function readManifest(dir) {
  return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
}

async function bundleText(dir) {
  const chunks = [];
  for (const name of await listFiles(dir)) {
    if (name.endsWith(".js")) chunks.push(await readFile(join(dir, name), "utf8"));
  }
  return chunks.join("\n");
}

function assertThat(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** Everything the manual run depends on, checked here so a bad build fails now and not in Chrome. */
async function verifyArtifacts({ v1Dir, zipPath, sig, pubKey, api }) {
  const v1 = await readManifest(v1Dir);
  assertThat(v1.version === FIRST_VERSION, `v1 manifest version is ${v1.version}`);
  assertThat(v1.host_permissions.includes("http://127.0.0.1/*"), "v1 may reach 127.0.0.1");
  assertThat(typeof v1.key === "string" && v1.key.length > 0, "v1 pins the extension key");

  const code = await bundleText(v1Dir);
  assertThat(code.includes(pubKey), "v1 trusts the throwaway key");
  assertThat(code.includes(api), "v1 asks the local releases address");
  assertThat(code.includes(MARKER), `v1 carries ${MARKER}`);

  const bytes = await readFile(zipPath);
  assertThat(verifyWithRawKey(bytes, sig, pubKey), "the signature verifies against the throwaway key");
  const productionKeys = JSON.parse(await readFile(join(ROOT, "src/update/releaseKeys.json"), "utf8"));
  assertThat(
    !productionKeys.some((key) => verifyWithRawKey(bytes, sig, key)),
    "the signature does not verify against the release keys",
  );

  const { unzipSync, strFromU8 } = await import("fflate");
  const entries = unzipSync(new Uint8Array(bytes));
  const next = JSON.parse(strFromU8(entries["manifest.json"]));
  assertThat(next.version === NEXT_VERSION, `the zip holds version ${next.version}`);
  assertThat(next.key === v1.key, "the zip's manifest key is the same as v1's");
  assertThat(!(STALE_FILE in entries), `the zip does not contain ${STALE_FILE}`);
  const list = JSON.parse(strFromU8(entries[FILE_LIST]));
  assertThat(list.includes("manifest.json") && list.includes(FILE_LIST), "the zip lists its own manifest and file list");
  return { v1, count: list.length };
}

/** Serves what GitHub would: the latest release as JSON, and its two assets. Resolves once it is listening. */
export function startServer({ port, assets, tag }) {
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const send = (status, type, body) => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(body);
      console.log(`${new Date().toLocaleTimeString()}  ${status}  ${req.method} ${path}`);
    };

    if (path === "/releases/latest") {
      return send(
        200,
        "application/json",
        JSON.stringify({
          tag_name: tag,
          published_at: new Date().toISOString(),
          assets: [...assets.keys()].map((name) => ({ name, browser_download_url: `${origin()}/assets/${name}` })),
        }),
      );
    }
    if (path === `/releases/tag/${tag}`) {
      return send(200, "text/html; charset=utf-8", `<!doctype html><title>${tag}</title><p>Test release ${tag}.</p>`);
    }
    const asset = path.startsWith("/assets/") ? assets.get(decodeURIComponent(path.slice("/assets/".length))) : undefined;
    if (asset) return send(200, "application/octet-stream", asset);
    return send(404, "text/plain", "not found");
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, "127.0.0.1", () => resolveStart(server));
  });
}

function instructions({ api, folder }) {
  const target = join(homedir(), "Documents", "Nashir-e2e");
  return `
Update check is ready.  Releases are served at ${api}
${"-".repeat(72)}
This setup belongs to THIS run. Every run makes a new throwaway key and a new
port, and the copy you load trusts only that key and that address. If you stop
the script and start it again, start over from step 1 with the fresh e2e/v1.

Set up
  1. Open Chrome's extensions page. Remove or turn off any other Nashir: this
     test build uses the same fixed extension ID. If you loaded an older copy
     of this test, remove it and delete ${target}
  2. Copy this folder:      ${folder}
     to:                    ${target}
  3. Extensions page > Developer mode > Load unpacked > pick that copy.
  4. Open the Nashir dashboard. Create a campaign draft, and let your groups
     list load, so you can see both survive the update.
  5. Put a file called notes.txt (any text) inside ${target}
  5b. In Nashir, switch on Lead Radar and engagement tracking (if you have
     them off). Then open the extension card's "service worker" link, and in
     its console run:   await chrome.alarms.getAll()
     Write down the alarm names (nashir:update-check, nashir:radar-tick,
     nashir:engagement-tick, ...).

Run the update
  6. Dashboard > Settings > Updates > Link folder > pick ${target}
  7. Press "Check for updates". The banner at the top and the Updates card
     should both offer version ${NEXT_VERSION}.
  8. Press "Update now". The extension reloads by itself.

What you should see afterwards
  - A dashboard tab saying "Updated to version ${NEXT_VERSION}".
  - The extension card on the extensions page shows version ${NEXT_VERSION}.
  - The campaign draft and the groups list are still there.
  - notes.txt is still in the folder, and ${STALE_FILE} is gone.
  - Open the service worker console again and run  await chrome.alarms.getAll()
    The same alarms must be listed as before the update.
  - Settings > Updates: press "Check for updates"; it says "Checked just now"
    and "You have the latest version."

Also worth trying: start a campaign before step 8 and see "Update now" refuse
with a message about a running job; pick the wrong folder in step 6 and see it
refused.

This window must stay open until you are done. Press Ctrl+C to stop.
${"-".repeat(72)}
`;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: node packages/extension/scripts/e2e-update.mjs [--dry-run] [--port <n>]");
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const portArg = option(argv, "--port");
  const port = portArg === undefined ? 0 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a number from 0 to 65535.");

  // Vite and the manifest read their files relative to the package.
  process.chdir(ROOT);
  const { pem, pubKey } = makeTestKey();

  // The releases address is baked into the builds, so the port is settled before building.
  const assets = new Map();
  const tag = `v${NEXT_VERSION}`;
  const server = dryRun ? null : await startServer({ port, assets, tag });
  const boundPort = dryRun ? DRY_RUN_PORT : server.address().port;
  const api = `http://127.0.0.1:${boundPort}/releases/latest`;

  try {
    await rm(E2E, { recursive: true, force: true });
    const v1Dir = join(E2E, "v1");
    const nextDir = join(E2E, `build-${NEXT_VERSION}`);

    console.log(`Building ${FIRST_VERSION} into ${relative(process.cwd(), v1Dir) || v1Dir} ...`);
    await buildVersion({ version: FIRST_VERSION, outDir: v1Dir, pubKey, api });
    await writeFile(join(v1Dir, STALE_FILE), "Present in 1.0.0 only. The update must remove it.\n");
    await writeFileList(v1Dir);

    console.log(`Building ${NEXT_VERSION} ...`);
    await buildVersion({ version: NEXT_VERSION, outDir: nextDir, pubKey, api });

    console.log("Packing and signing ...");
    const { zipPath } = await packRelease({ dist: nextDir, out: join(E2E, "release") });
    const { sig } = signFile(zipPath, pem);
    await writeFile(`${zipPath}.sig`, sig);

    const { count } = await verifyArtifacts({ v1Dir, zipPath, sig, pubKey, api });
    console.log(`Verified: ${basename(zipPath)} (${count} files) is signed by the throwaway key and by nothing else.`);

    if (dryRun) {
      console.log("Dry run: not starting the server.");
      return;
    }

    assets.set(basename(zipPath), await readFile(zipPath));
    assets.set(`${basename(zipPath)}.sig`, Buffer.from(sig));
    console.log(instructions({ api, folder: v1Dir }));

    await new Promise((done) => {
      process.once("SIGINT", () => {
        console.log("\nStopping.");
        done();
      });
    });
  } finally {
    server?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
