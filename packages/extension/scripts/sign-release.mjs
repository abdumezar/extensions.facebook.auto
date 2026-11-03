/**
 * Sign a release archive.
 *
 *   RELEASE_SIGNING_KEY="<PKCS#8 PEM text>" node scripts/sign-release.mjs release/nashir-1.0.0.zip
 *
 * Writes `<zip>.sig` (base64, raw 64-byte ed25519 signature over the zip bytes) and adds
 * `<sha256>  <zip name>` to `SHA256SUMS` beside the zip. The signing key arrives only
 * through the environment, as a PKCS#8 PEM.
 *
 * Built-ins only: the job that runs this has no `pnpm install`, so nothing here may be
 * imported from npm.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** DER prefix that turns a raw 32-byte ed25519 public key into an SPKI structure. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DEFAULT_KEYS_FILE = join(dirname(fileURLToPath(import.meta.url)), "../src/update/releaseKeys.json");

/**
 * Whether `sigB64` is a valid signature over `data` by the raw public key `rawKeyB64`.
 * Malformed input is just `false`. This is the only place a raw key is wrapped for node.
 *
 * @param {Buffer} data
 * @param {string} sigB64
 * @param {string} rawKeyB64
 * @returns {boolean}
 */
export function verifyWithRawKey(data, sigB64, rawKeyB64) {
  try {
    const raw = Buffer.from(rawKeyB64, "base64");
    if (raw.length !== 32) return false;
    const signature = Buffer.from(sigB64.trim(), "base64");
    if (signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/**
 * Never echoes the secret: node's own parse errors are replaced by fixed messages.
 *
 * @param {string} pem
 */
function loadSigningKey(pem) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("RELEASE_SIGNING_KEY is not a PKCS#8 PEM.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`RELEASE_SIGNING_KEY must be an ed25519 key, not ${key.asymmetricKeyType}.`);
  }
  return key;
}

/**
 * @param {Buffer} bytes
 * @param {string} pem PKCS#8 PEM of an ed25519 key
 * @returns {{ sig: string, sha256: string }} base64 signature and hex SHA-256 of the bytes
 */
export function signBytes(bytes, pem) {
  const signature = sign(null, bytes, loadSigningKey(pem));
  return { sig: signature.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * @param {string} zipPath
 * @param {string} pem PKCS#8 PEM of an ed25519 key
 * @returns {{ sig: string, sha256: string }}
 */
export function signFile(zipPath, pem) {
  return signBytes(readFileSync(zipPath), pem);
}

/** Replaces any line for `name`, then appends this one, so re-running never duplicates. */
function updateChecksums(sumsPath, name, sha256) {
  const existing = existsSync(sumsPath) ? readFileSync(sumsPath, "utf8").split(/\r?\n/) : [];
  const kept = existing.filter((line) => line !== "" && !line.endsWith(`  ${name}`));
  writeFileSync(sumsPath, [...kept, `${sha256}  ${name}`].join("\n") + "\n");
}

function main(argv, env) {
  const args = [...argv];
  let keysFile = DEFAULT_KEYS_FILE;
  const flag = args.indexOf("--keys");
  if (flag !== -1) {
    keysFile = resolve(args[flag + 1] ?? "");
    args.splice(flag, 2);
  }
  const [zipArg] = args;
  if (!zipArg) {
    console.error("Usage: node sign-release.mjs <zip> [--keys <releaseKeys.json>]");
    return 1;
  }
  const pem = env.RELEASE_SIGNING_KEY;
  if (!pem) {
    console.error("RELEASE_SIGNING_KEY is not set.");
    return 1;
  }

  const zipPath = resolve(zipArg);
  const bytes = readFileSync(zipPath);
  const { sig, sha256 } = signBytes(bytes, pem);

  // A secret that does not belong to the published key would produce a signature every
  // install rejects. Find that out here, before anything is written next to the zip.
  const publicKeys = JSON.parse(readFileSync(keysFile, "utf8"));
  if (!publicKeys.some((key) => verifyWithRawKey(bytes, sig, key))) {
    console.error("The signature does not verify against any key in the release key list; nothing was written.");
    return 1;
  }

  const name = basename(zipPath);
  writeFileSync(`${zipPath}.sig`, sig);
  updateChecksums(join(dirname(zipPath), "SHA256SUMS"), name, sha256);
  console.log(`sig  ${name}.sig`);
  console.log(`sum  ${sha256}  ${name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
