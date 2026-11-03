/**
 * CLI entry for the token generator: pnpm --filter @nashir/extension gen:tokens
 *
 * Kept separate from gen-tokens.ts so that module stays pure and importable —
 * the drift-guard test imports buildTokensCss() without writing anything, and
 * vite-node does not rewrite process.argv[1], so a "am I the main module?"
 * guard inside the generator would not work anyway.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTokensCss } from "./gen-tokens.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../src/dashboard/tokens.css");
writeFileSync(out, buildTokensCss(), "utf8");
console.log(`wrote ${out}`);
