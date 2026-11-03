import type { DelayConfig, SafetyBreakConfig, AntiDetectionConfig } from "./safety.js";

/** One image or video attached to a campaign; every attachment goes on every post. */
export interface CampaignMedia {
  /** Local id referencing the blob in IndexedDB (MediaStore). */
  blobId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Whether this is a photo or a video (drives which upload pipeline runs). */
  kind: "image" | "video";
}

/** Facebook's own composer ceiling for one post. */
export const MAX_CAMPAIGN_MEDIA = 10;

/** A full, saveable campaign definition. */
export interface Campaign {
  id: string;
  name: string;
  /** Target account ids. Order defines account sequencing. */
  accountIds: string[];
  /** Target group ids (resolved against each account's joined groups). */
  groupIds: string[];
  /** One or more caption variations, cycled across groups. */
  variations: string[];
  /** Images and videos attached to every post, in the order shown in the composer. */
  media?: CampaignMedia[];
  /** Chosen link URL for a preview card (overridden by media if both present). */
  linkUrl?: string;
  delay: DelayConfig;
  safetyBreak: SafetyBreakConfig;
  antiDetection: AntiDetectionConfig;
  /**
   * Text posted as the first comment on every post that lands.
   *
   * The reason this exists rather than being appended to the caption: Facebook demotes
   * a post carrying an outbound link, and the first comment is where responders reply
   * anyway. Only ever attempted for a post that actually published — a post pending
   * admin approval has nothing to comment on yet.
   */
  firstComment?: string;
  /** Native FB schedule time (epoch millis), if scheduling the whole campaign. */
  scheduledAt?: number;
  createdAt: number;
  updatedAt: number;
}
