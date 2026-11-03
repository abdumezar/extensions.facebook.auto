import type { UiRequest, UiResponse } from "@nashir/shared";

/** Typed RPC to the service worker. Throws on transport failure; returns the envelope otherwise. */
export async function rpc<T = unknown>(req: UiRequest): Promise<UiResponse<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as UiResponse<T>;
    return res ?? { ok: false, error: "No response from background" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Convenience: unwrap data or throw the error. */
export async function call<T = unknown>(req: UiRequest): Promise<T> {
  const res = await rpc<T>(req);
  if (!res.ok) throw new Error(res.error ?? "Request failed");
  return res.data as T;
}
