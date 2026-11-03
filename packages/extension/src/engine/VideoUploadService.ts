import type { FbRecipe, SessionTokens } from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";
import { parseFbJson } from "./fbResponse.js";

/**
 * VideoUploadService — Facebook's 3-phase AJAX video upload (endpoints captured from
 * comet_composer_video_uploader_config):
 *   1. start    -> returns a video_id + the first chunk's [start_offset, end_offset)
 *   2. transfer -> POST chunk bytes; returns the next offsets; repeat to EOF
 *   3. receive  -> finalize; the video_id is then attached to the composer mutation
 *
 * Runs in the service worker; DNR rewrites Origin/Referer for the vupload hosts. The
 * exact per-phase field names are the one part still to confirm against a live vupload
 * capture — every phase logs its raw response so it can be finalized without churn.
 */
export class VideoUploadService {
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
    const ep = recipe.endpoints.uploadVideo;

    // Phase 1 — start.
    const startForm = this.fbForm(tokens);
    startForm.set("file_size", String(blob.size));
    startForm.set("file_name", filename);
    const start = await this.postJson(ep.start, startForm);
    this.logger.info("FB video start", { snippet: JSON.stringify(start).slice(0, 300) });
    const p0 = start?.payload ?? start;
    const videoId: string | undefined = p0?.video_id ?? p0?.videoID;
    if (!videoId) throw new Error("Video start did not return a video_id");

    let startOffset = Number(p0?.start_offset ?? 0);
    let endOffset = Number(p0?.end_offset ?? blob.size);

    // Phase 2 — transfer chunks until the whole file is sent.
    let guard = 0;
    while (startOffset < blob.size && guard++ < 10_000) {
      const end = Math.min(endOffset || blob.size, blob.size);
      const chunk = blob.slice(startOffset, end);
      const form = this.fbForm(tokens);
      form.set("video_id", videoId);
      form.set("start_offset", String(startOffset));
      form.set("end_offset", String(end));
      form.set("chunk", chunk, filename);
      const res = await this.postJson(ep.transfer, form);
      const p = res?.payload ?? res;
      const nextStart = Number(p?.start_offset);
      const nextEnd = Number(p?.end_offset);
      if (Number.isFinite(nextStart) && nextStart > startOffset) {
        startOffset = nextStart;
        endOffset = Number.isFinite(nextEnd) ? nextEnd : blob.size;
      } else {
        // Server didn't advance the offset — assume this chunk completed the file.
        startOffset = end;
      }
      this.logger.info("FB video chunk", { sent: end, total: blob.size });
    }

    // Phase 3 — receive / finalize.
    const recvForm = this.fbForm(tokens);
    recvForm.set("video_id", videoId);
    const recv = await this.postJson(ep.receive, recvForm);
    this.logger.info("FB video receive", { snippet: JSON.stringify(recv).slice(0, 200) });

    return videoId;
  }

  private fbForm(t: SessionTokens): FormData {
    const f = new FormData();
    f.set("av", t.av);
    f.set("__user", t.user);
    f.set("__a", "1");
    f.set("__comet_req", t.cometReq);
    f.set("fb_dtsg", t.fb_dtsg);
    f.set("jazoest", t.jazoest);
    f.set("lsd", t.lsd);
    f.set("__spin_r", t.spinR);
    f.set("__spin_b", t.spinB);
    f.set("__spin_t", t.spinT);
    return f;
  }

  private async postJson(url: string, form: FormData): Promise<any> {
    const res = await this.http.fetch(url + (url.includes("?") ? "" : "?__a=1"), {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const text = await res.text();
    const json = parseFbJson(text);
    if (json == null) {
      this.logger.warn("Unparseable video-upload response", { url, snippet: text.slice(0, 200) });
    }
    return json;
  }
}
