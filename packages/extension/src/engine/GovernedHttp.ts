import type { FbRecipe } from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";
import type { CallGovernor } from "./CallGovernor.js";
import { classifyEndpoint, detectThrottle } from "./governorMath.js";

/** Bodies larger than this are not cloned for inspection. Every FB body here is tiny. */
const MAX_INSPECT_BYTES = 2_000_000;

/**
 * GovernedHttp — the seam where every Facebook request meets the call budget.
 *
 * `HttpPort` is the one chokepoint nothing bypasses: `FacebookClient`, `GroupService`,
 * `GroupLeaveService`, both upload services and `LinkPreviewService` are all handed
 * the same instance by the composition root. Decorating it governs all six with no
 * changes to any of them.
 *
 * Requests to hosts other than Facebook pass through untouched: only Facebook's
 * limits are being protected, so only Facebook's traffic is paced.
 */
export class GovernedHttp implements HttpPort {
  constructor(
    private readonly inner: HttpPort,
    private readonly governor: CallGovernor,
    private readonly getRecipe: () => Promise<FbRecipe>,
    private readonly logger: LoggerPort,
    /** Whose quota this request spends. Ambient, from the cookie-swap mutex. */
    private readonly getAccountId: () => string | undefined = () => undefined,
  ) {}

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    const friendly = friendlyNameOf(init);
    const recipe = await this.safeRecipe();
    const target = classifyEndpoint(input, friendly, recipe);
    if (!target) return this.inner.fetch(input, init);

    const accountId = this.getAccountId();
    const startedAt = Date.now();
    await this.governor.acquire(target.domain, target.cls, accountId);
    const waitedMs = Date.now() - startedAt;

    let res: Response;
    try {
      res = await this.inner.fetch(input, init);
    } catch (err) {
      // A network failure is still information: it may be Facebook cutting us off.
      const message = err instanceof Error ? err.message : String(err);
      if (recipe) await this.governor.report(detectThrottle({ bodyText: message, recipe }));
      throw err;
    }

    const sentAt = Date.now();
    if (recipe) {
      const headers = headerMap(res.headers);
      const bodyText = await peekBody(res);
      await this.governor.report(
        detectThrottle({ status: res.status, headers, bodyText, recipe }, sentAt),
        accountId,
      );
    }

    // One uniform line per governed call. Before this, a call timeline could not be
    // reconstructed from the logs at all — which is why the incident had to be
    // diagnosed from the code rather than from what the app recorded.
    const counts = await this.governor.snapshot();
    this.logger.info("FB call", {
      cls: target.cls,
      domain: target.domain,
      friendly,
      status: res.status,
      ms: sentAt - startedAt - waitedMs,
      waitedMs,
      callsLastMinute: counts.callsLastMinute,
      callsLastHour: counts.callsLastHour,
      accountId,
    });

    return res;
  }

  /**
   * The recipe drives both classification and detection, but a request must never fail
   * because the recipe could not be read. Without it the call still goes out, ungoverned
   * and unclassified, which is the same behaviour as before this decorator existed.
   */
  private async safeRecipe(): Promise<FbRecipe | undefined> {
    try {
      return await this.getRecipe();
    } catch {
      return undefined;
    }
  }
}

/** The relay query name, which is how a GraphQL POST says what it is for. */
function friendlyNameOf(init?: RequestInit): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get("x-fb-friendly-name") ?? undefined;
  if (Array.isArray(h)) {
    return h.find(([k]) => k.toLowerCase() === "x-fb-friendly-name")?.[1];
  }
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "x-fb-friendly-name") return v;
  }
  return undefined;
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * Read the body without consuming it.
 *
 * The internal endpoints report a throttle as HTTP 200 with the error inside the JSON,
 * so the body has to be inspected — but every caller downstream still calls
 * `res.text()`, and a body can only be read once. Cloning is what buys the
 * zero-call-site-edit property, and getting it wrong would silently break every parser
 * in the engine, so it has its own test.
 */
async function peekBody(res: Response): Promise<string | undefined> {
  const type = res.headers.get("content-type") ?? "";
  if (type && !/json|text|javascript/i.test(type)) return undefined;
  const length = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_INSPECT_BYTES) return undefined;
  try {
    return await res.clone().text();
  } catch {
    return undefined;
  }
}
