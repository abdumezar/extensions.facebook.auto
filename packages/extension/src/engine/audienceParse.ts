/**
 * audienceParse — read people out of Facebook's reactor and comment responses. Pure.
 *
 * Written against a HAR captured 2026-08-27. The shapes below are the ones Facebook
 * actually returned, but the parsing is deliberately *not* path-dependent: the same
 * tolerant-walk approach `GroupService.collectGroups` uses, because the one thing
 * every previous Facebook integration in this repo has learned is that the path moves
 * and the shape of the leaf does not.
 *
 * The fast path reads the known location; the fallback walks for anything that looks
 * like the connection. When the fast path stops working we get degraded results and a
 * log line, rather than an empty table and no explanation.
 */

import type { AudienceSighting, FbRecipe } from "@nashir/shared";

/** A person as Facebook describes them in either list. */
export interface ParsedActor {
  id: string;
  name: string;
  profileUrl?: string;
  profilePicUrl?: string;
  isVerified?: boolean;
}

export interface ParsedReactor {
  actor: ParsedActor;
  /** Facebook's numeric reaction id, unmapped. */
  reactionId?: string;
}

export interface ParsedComment {
  actor: ParsedActor;
  commentId: string;
  parentId?: string;
  depth?: number;
  text: string;
  createdAt?: number;
}

/** A Relay connection page: the rows, and how to ask for the next one. */
export interface ParsedPage<T> {
  items: T[];
  endCursor?: string;
  hasNextPage: boolean;
  /** Facebook's own total for the connection, when it reports one. */
  totalCount?: number;
}

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Depth-first search for the first node satisfying `pred`.
 *
 * Bounded: a Facebook response is a few thousand nodes and a cycle would hang the
 * service worker, so both the visited set and the node budget are real guards, not
 * defensive decoration.
 */
function findNode(
  root: Json,
  pred: (o: Record<string, Json>) => boolean,
  budget = 200_000,
): Record<string, Json> | undefined {
  const seen = new Set<Json>();
  const stack: Json[] = [root];
  let n = 0;
  while (stack.length > 0 && n++ < budget) {
    const cur = stack.pop();
    if (cur === undefined || cur === null || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (isObj(cur)) {
      if (pred(cur)) return cur;
      for (const v of Object.values(cur)) stack.push(v);
    } else if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    }
  }
  return undefined;
}

/** Relay `page_info`, wherever it ended up. */
function readPageInfo(conn: Record<string, Json>): { endCursor?: string; hasNextPage: boolean } {
  const pi = conn["page_info"];
  if (isObj(pi)) {
    const cursor = pi["end_cursor"];
    return {
      hasNextPage: pi["has_next_page"] === true,
      ...(typeof cursor === "string" && cursor.length > 0 ? { endCursor: cursor } : {}),
    };
  }
  return { hasNextPage: false };
}

/** Anything shaped like a Relay connection: `edges` array plus `page_info`. */
function looksLikeConnection(o: Record<string, Json>): boolean {
  return Array.isArray(o["edges"]) && isObj(o["page_info"]);
}

function str(v: Json): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function uriOf(v: Json): string | undefined {
  return isObj(v) ? str(v["uri"]) : undefined;
}

/**
 * A person, from any of the several shapes Facebook uses for one.
 *
 * The reactor list nests the actor under `node`; the comment list calls it `author`
 * and gives the avatar a depth-suffixed key. Both are handled here so callers do not
 * have to know which list they came from.
 */
export function parseActor(o: Json): ParsedActor | undefined {
  if (!isObj(o)) return undefined;
  const id = str(o["id"]);
  const name = str(o["name"]);
  if (!id || !name) return undefined;
  // Facebook ids are numeric and long. A short or non-numeric id here means the walk
  // found some other named node (an entity in a text range, a badge) and not a person.
  if (!/^\d{5,}$/.test(id)) return undefined;

  const pic =
    uriOf(o["profile_picture"]) ??
    uriOf(o["profile_picture_depth_0"]) ??
    uriOf(o["profile_picture_depth_1"]);
  const url = str(o["profile_url"]) ?? str(o["url"]);
  const verified = o["is_verified"];

  return {
    id,
    name,
    ...(url ? { profileUrl: url } : {}),
    ...(pic ? { profilePicUrl: pic } : {}),
    ...(typeof verified === "boolean" ? { isVerified: verified } : {}),
  };
}

// ---------------------------------------------------------------- reactors

/**
 * `data.node.reactors` — edges of `{ node: <actor>, feedback_reaction_info: { id } }`.
 *
 * The reaction *id* is what we keep. Facebook also sends `localized_name`, but it is
 * in the viewer's language, so storing it would make an Arabic operator's export
 * incomparable with an English one's.
 */
export function parseReactors(body: Json): ParsedPage<ParsedReactor> {
  const data = isObj(body) ? body["data"] : undefined;
  const node = isObj(data) ? data["node"] : undefined;
  let conn = isObj(node) && isObj(node["reactors"]) ? (node["reactors"] as Record<string, Json>) : undefined;

  if (!conn) {
    conn = findNode(
      body,
      (o) =>
        looksLikeConnection(o) &&
        (o["edges"] as Json[]).some((e) => isObj(e) && "feedback_reaction_info" in e),
    );
  }
  if (!conn) return { items: [], hasNextPage: false };

  const items: ParsedReactor[] = [];
  for (const edge of conn["edges"] as Json[]) {
    if (!isObj(edge)) continue;
    const actor = parseActor(edge["node"]);
    if (!actor) continue;
    const info = edge["feedback_reaction_info"];
    const reactionId = isObj(info) ? str(info["id"]) : undefined;
    items.push({ actor, ...(reactionId ? { reactionId } : {}) });
  }
  return { items, ...readPageInfo(conn) };
}

// ---------------------------------------------------------------- comments

/**
 * `data.node.comment_rendering_instance_for_feed_location.comments`, or the same
 * connection wherever the pagination query puts it.
 */
export function parseComments(body: Json): ParsedPage<ParsedComment> {
  const data = isObj(body) ? body["data"] : undefined;
  const node = isObj(data) ? data["node"] : undefined;
  const cri = isObj(node) ? node["comment_rendering_instance_for_feed_location"] : undefined;
  let conn =
    isObj(cri) && isObj(cri["comments"]) ? (cri["comments"] as Record<string, Json>) : undefined;

  if (!conn) {
    // Either the pagination response (which nests differently) or a moved path.
    conn = findNode(
      body,
      (o) =>
        looksLikeConnection(o) &&
        (o["edges"] as Json[]).some((e) => isObj(e) && isObj(e["node"]) && "body" in (e["node"] as object)),
    );
  }
  if (!conn) return { items: [], hasNextPage: false };

  const items: ParsedComment[] = [];
  for (const edge of conn["edges"] as Json[]) {
    if (!isObj(edge)) continue;
    const cnode = edge["node"];
    if (!isObj(cnode)) continue;
    const actor = parseActor(cnode["author"]);
    const commentId = str(cnode["id"]) ?? str(cnode["legacy_fbid"]);
    if (!actor || !commentId) continue;

    const body_ = cnode["body"];
    const text = isObj(body_) ? (str(body_["text"]) ?? "") : "";
    const depth = typeof cnode["depth"] === "number" ? cnode["depth"] : undefined;
    const created = typeof cnode["created_time"] === "number" ? cnode["created_time"] : undefined;
    const parent = cnode["comment_direct_parent"];
    const parentId = isObj(parent) ? str(parent["id"]) : undefined;

    items.push({
      actor,
      commentId,
      text,
      ...(parentId ? { parentId } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(created !== undefined ? { createdAt: created } : {}),
    });
  }

  const total = conn["total_count"];
  return {
    items,
    ...readPageInfo(conn),
    ...(typeof total === "number" ? { totalCount: total } : {}),
  };
}

// ---------------------------------------------------------------- rosters

/**
 * A member or follower list.
 *
 * The plainest connection shape in the product: edges of actors, no reaction and no
 * body. Because neither doc_id is captured yet, this is written entirely as a
 * tolerant walk — it looks for the first connection whose edges carry people.
 */
export function parseRoster(body: Json): ParsedPage<ParsedActor> {
  const conn = findNode(
    body,
    (o) => looksLikeConnection(o) && (o["edges"] as Json[]).some((e) => isObj(e) && !!parseActor(e["node"])),
  );
  if (!conn) return { items: [], hasNextPage: false };

  const items: ParsedActor[] = [];
  for (const edge of conn["edges"] as Json[]) {
    if (!isObj(edge)) continue;
    const actor = parseActor(edge["node"]);
    if (actor) items.push(actor);
  }
  return { items, ...readPageInfo(conn) };
}

// ---------------------------------------------------------------- ids

/**
 * Facebook addresses a post's feedback by an opaque base64 of `feedback:<id>`.
 *
 * Encoded here rather than passed around as the raw token because the raw token is
 * the thing that would silently break: it is base64 of a string, and a caller that
 * assembled it by hand would eventually hand us base64 of the wrong string.
 */
export function encodeFeedbackTarget(feedbackId: string): string {
  return btoa(`feedback:${feedbackId}`);
}

/** The inverse, used to read a feedback id back out of a page. */
export function decodeFeedbackTarget(token: string): string | undefined {
  try {
    const decoded = atob(token);
    const m = /^feedback:(\d+)$/.exec(decoded);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Find the post's feedback id in the HTML of its permalink.
 *
 * Three passes, most reliable first. The base64 token is preferred because it is
 * unambiguous — `feedback:` is not a string that occurs by accident — where a bare
 * `"feedback":{"id":...}` can also belong to a comment's own feedback object.
 */
export function findFeedbackId(html: string): string | undefined {
  // 1. The encoded target, as the audience queries themselves take it.
  for (const m of html.matchAll(/ZmVlZGJhY2s6[A-Za-z0-9+/=]{4,}/g)) {
    const id = decodeFeedbackTarget(m[0]);
    if (id) return id;
  }
  // 2. An explicitly named field.
  const named = /"feedback_target_id"\s*:\s*"?(\d{6,})"?/.exec(html);
  if (named?.[1]) return named[1];
  // 3. A feedback object whose id is numeric rather than encoded.
  const obj = /"feedback"\s*:\s*\{\s*"id"\s*:\s*"(\d{6,})"/.exec(html);
  if (obj?.[1]) return obj[1];
  return undefined;
}

/**
 * The numeric group id, from the HTML of a group post's permalink.
 *
 * Needed because most group URLs carry a vanity slug (`/groups/examplegroup/…`)
 * rather than an id. Storing the slug would work, but then the same group reached by
 * slug and by id would be two different groups in the store — and the whole value of
 * the audience table is that sightings of one person, or one group, converge.
 *
 * Best effort: the caller keeps the slug when this finds nothing, which is a slightly
 * worse key rather than a failure.
 */
export function findGroupId(html: string): string | undefined {
  for (const re of [
    /"groupID"\s*:\s*"(\d{5,})"/,
    /"group_id"\s*:\s*"?(\d{5,})"?/,
    /\/groups\/(\d{5,})\//,
    /"__typename"\s*:\s*"Group"\s*,\s*"id"\s*:\s*"(\d{5,})"/,
  ]) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * Read a post permalink into the ids the audience queries need.
 *
 * The patterns come from the recipe so a new Facebook URL shape is a data change.
 * A pattern that does not compile, or that lacks the `story` group, is skipped
 * rather than thrown on: one bad pattern must not disable extraction.
 */
export function parsePostUrl(
  url: string,
  recipe: FbRecipe,
): { storyId?: string; groupId?: string } {
  for (const src of recipe.postUrlPatterns ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(src);
    } catch {
      continue;
    }
    const m = re.exec(url);
    const groups = m?.groups;
    if (!groups?.["story"]) continue;
    return {
      storyId: groups["story"],
      ...(groups["group"] ? { groupId: groups["group"] } : {}),
    };
  }
  return {};
}

/** Map Facebook's numeric reaction id to a stable English name, or keep the number. */
export function reactionName(reactionId: string | undefined, recipe: FbRecipe): string | undefined {
  if (!reactionId) return undefined;
  return recipe.postAudience?.reactionNames?.[reactionId] ?? reactionId;
}

/** Build the sighting a reactor row becomes. */
export function reactorSighting(
  r: ParsedReactor,
  ctx: { postUrl: string; feedbackId: string; groupId?: string; now: number },
  recipe: FbRecipe,
): AudienceSighting {
  const reaction = reactionName(r.reactionId, recipe);
  return {
    source: "post.reactor",
    postUrl: ctx.postUrl,
    feedbackId: ctx.feedbackId,
    capturedAt: ctx.now,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    ...(reaction ? { reaction } : {}),
  };
}

/** Build the sighting a comment row becomes. */
export function commentSighting(
  c: ParsedComment,
  ctx: { postUrl: string; feedbackId: string; groupId?: string; now: number; own?: boolean },
  _recipe: FbRecipe,
): AudienceSighting {
  return {
    source: ctx.own ? "own.commenter" : "post.commenter",
    postUrl: ctx.postUrl,
    feedbackId: ctx.feedbackId,
    commentId: c.commentId,
    text: c.text,
    capturedAt: ctx.now,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    ...(c.parentId ? { parentId: c.parentId } : {}),
    ...(c.depth !== undefined ? { depth: c.depth } : {}),
    ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
  };
}
