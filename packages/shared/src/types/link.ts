/**
 * Link preview cards.
 *
 * Worth being precise about what this does and does not affect: attaching a link to a
 * post needs nothing but the URL — Facebook builds the card server-side when the post
 * goes out. Fetching a preview here is so the operator can SEE what that card will look
 * like before committing a campaign to it, which is a different (and optional) thing.
 * A preview that cannot be fetched must therefore never block posting.
 */

export type LinkPreviewStatus =
  | "ok"
  /** Facebook returned nothing usable for this URL (dead link, blocked, no metadata). */
  | "empty"
  /** The request failed. The link still attaches. */
  | "failed"
  /** We have no captured query for link previews yet — see `FbRecipe.linkPreview`. */
  | "unsupported";

export interface LinkPreview {
  url: string;
  status: LinkPreviewStatus;
  title?: string;
  description?: string;
  imageUrl?: string;
  /** Display domain, e.g. "example.com". */
  siteName?: string;
  /** Why a non-ok status happened, for the log and the UI. */
  detail?: string;
  fetchedAt: number;
}
