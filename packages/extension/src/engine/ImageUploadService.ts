import type { FbRecipe, SessionTokens } from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";
import { parseFbJson, stripFbPrefix } from "./fbResponse.js";

/**
 * ImageUploadService — uploads a photo to Facebook and returns its photo id, which
 * FacebookClient then attaches to the group-composer mutation.
 *
 * The exact multipart shape (endpoint, file field name, extra params) is captured live
 * (like the composer/groups queries). This implementation posts the known react_composer
 * photo-upload form and parses the returned id; the raw response is logged so the request
 * can be finalized against a real capture without touching the rest of the engine.
 *
 * Runs in the service worker, so the DNR rules rewrite Origin/Referer for upload.facebook.com.
 */
export class ImageUploadService {
  constructor(
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
  ) {}

  async upload(
    blob: Blob,
    filename: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<string> {
    const form = new FormData();
    // Standard session params (mirrors the composer request).
    form.set("av", tokens.av);
    form.set("__user", tokens.user);
    form.set("__a", "1");
    form.set("__comet_req", tokens.cometReq);
    form.set("fb_dtsg", tokens.fb_dtsg);
    form.set("jazoest", tokens.jazoest);
    form.set("lsd", tokens.lsd);
    form.set("__spin_r", tokens.spinR);
    form.set("__spin_b", tokens.spinB);
    form.set("__spin_t", tokens.spinT);
    // Photo-upload specifics (finalize field names from a live capture).
    form.set("source", "8");
    form.set("profile_id", tokens.av);
    form.set("waterfallxapp", "comet");
    form.set("farr", blob, filename);

    const res = await this.http.fetch(recipe.endpoints.uploadPhoto, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const text = await res.text();
    this.logger.info("FB photo upload response", { httpOk: res.ok, snippet: text.slice(0, 400) });

    const photoId = this.extractPhotoId(text);
    if (!photoId) {
      throw new Error(`Photo upload did not return an id (HTTP ${res.status})`);
    }
    return photoId;
  }

  private extractPhotoId(text: string): string | undefined {
    const cleaned = stripFbPrefix(text);
    const json: any = parseFbJson(text);
    if (json == null) return undefined;
    const p = json?.payload ?? json?.data ?? json;
    const candidates = [p?.photoID, p?.photo_id, p?.fbid, p?.id, p?.photo?.id];
    const direct = candidates.find((c: unknown) => typeof c === "string" && /^\d{5,}$/.test(c));
    if (direct) return direct as string;
    // Fallback: first long digit run near a "photo"/"fbid" key in the raw text.
    const m = cleaned.match(/"(?:photoID|photo_id|fbid)":"?(\d{6,})/);
    return m?.[1];
  }
}
