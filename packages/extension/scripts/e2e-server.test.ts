import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { StoragePort } from "../src/engine/ports/index.js";
import { UpdateService } from "../src/update/UpdateService.js";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { startServer } from "./e2e-update.mjs";

/**
 * The end-to-end script serves what GitHub would. The extension's own update check is the
 * judge of whether it does, so these tests point a real UpdateService at it.
 */

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function memory(): StoragePort {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (map.get(key) as T) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

const assets = () =>
  new Map<string, Buffer>([
    ["nashir-1.0.1.zip", Buffer.from("zip bytes")],
    ["nashir-1.0.1.zip.sig", Buffer.from("c2lnbmF0dXJl")],
  ]);

async function serve() {
  server = (await startServer({ port: 0, assets: assets(), tag: "v1.0.1" })) as Server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return origin;
}

describe("the end-to-end releases server", () => {
  it("is offered by the update check as a newer release, with assets on its own origin", async () => {
    const origin = await serve();
    const service = new UpdateService({ fetch: (url, init) => fetch(url, init) }, memory(), `${origin}/releases/latest`, () => "1.0.0");

    const state = await service.check();

    expect(state).toMatchObject({
      status: "available",
      current: "1.0.0",
      latest: {
        version: "1.0.1",
        zipUrl: `${origin}/assets/nashir-1.0.1.zip`,
        sigUrl: `${origin}/assets/nashir-1.0.1.zip.sig`,
        notesUrl: `${origin}/releases/tag/v1.0.1`,
      },
    });
  });

  it("serves the asset bytes it was given", async () => {
    const origin = await serve();
    const zip = await fetch(`${origin}/assets/nashir-1.0.1.zip`);
    expect(zip.status).toBe(200);
    expect(Buffer.from(await zip.arrayBuffer()).toString()).toBe("zip bytes");
    expect(await (await fetch(`${origin}/assets/nashir-1.0.1.zip.sig`)).text()).toBe("c2lnbmF0dXJl");
  });

  it("answers the same running version with nothing to update", async () => {
    const origin = await serve();
    const service = new UpdateService({ fetch: (url, init) => fetch(url, init) }, memory(), `${origin}/releases/latest`, () => "1.0.1");
    expect((await service.check()).status).toBe("idle");
  });

  it("serves nothing else, and never from outside the assets folder", async () => {
    const origin = await serve();
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/assets/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${origin}/assets/other.zip`)).status).toBe(404);
  });
});
