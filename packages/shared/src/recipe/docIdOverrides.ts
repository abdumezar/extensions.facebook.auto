/**
 * Locally observed doc_ids layered over the bundled recipe.
 *
 * Facebook rotates the persisted-query ids behind its GraphQL operations. When the
 * extension sees a newer id in a logged-in Facebook tab, it stores it here as an
 * override keyed by the operation's `friendlyName`. Everything in this file is
 * pure: no storage, no network, no globals.
 */

import type { FbRecipe } from "./fbRecipe.js";

export type DocIdOverride = {
  docId: string;
  /** Epoch ms when the id was observed. */
  seenAt: number;
  /** The bundled docId this override replaced; guards against a stale override. */
  bundledAtLearn: string;
};

/** friendlyName -> override. */
export type DocIdOverrides = Record<string, DocIdOverride>;

const DOC_ID_PATTERN = /^\d{5,25}$/;

type QueryNode = { docId: string; friendlyName: string };

function isQueryNode(value: unknown): value is QueryNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return typeof node.docId === "string" && typeof node.friendlyName === "string";
}

/** Visits every `{ docId, friendlyName }` node in the tree. */
function forEachQueryNode(value: unknown, visit: (node: QueryNode) => void): void {
  if (isQueryNode(value)) {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) forEachQueryNode(item, visit);
  } else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) forEachQueryNode(child, visit);
  }
}

/**
 * Deep copy of the tree with `replace` applied to every query node's docId. Extra
 * fields on a query node are copied too, so nothing is shared with the input.
 */
function mapQueryNodes<T>(value: T, replace: (node: QueryNode) => QueryNode): T {
  if (Array.isArray(value)) return value.map((item) => mapQueryNodes(item, replace)) as T;
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = mapQueryNodes(child, replace);
  }
  if (isQueryNode(value)) copy.docId = replace(value).docId;
  return copy as T;
}

/** Every `friendlyName` in the recipe tree, unique, in tree order. */
export function recipeFriendlyNames(recipe: FbRecipe): string[] {
  return Object.keys(bundledDocIds(recipe));
}

/**
 * friendlyName -> the docId the recipe currently carries. A duplicate friendlyName
 * keeps the last node's id; an override then applies only to the node whose docId
 * equals its `bundledAtLearn`.
 */
export function bundledDocIds(recipe: FbRecipe): Record<string, string> {
  const ids: Record<string, string> = {};
  forEachQueryNode(recipe, (node) => {
    ids[node.friendlyName] = node.docId;
  });
  return ids;
}

/**
 * New recipe with override ids applied. An override only counts while the node
 * still carries the id it was learned against, so a newer bundle wins over a
 * stale override.
 */
export function applyDocIdOverrides(recipe: FbRecipe, overrides: DocIdOverrides): FbRecipe {
  return mapQueryNodes(recipe, (node) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, node.friendlyName)
      ? overrides[node.friendlyName]
      : undefined;
    if (
      !override ||
      typeof override !== "object" ||
      typeof override.docId !== "string" ||
      !DOC_ID_PATTERN.test(override.docId) ||
      typeof override.bundledAtLearn !== "string" ||
      override.bundledAtLearn !== node.docId
    ) {
      return node;
    }
    return { docId: override.docId, friendlyName: node.friendlyName };
  });
}

/**
 * Untrusted page output -> clean friendlyName -> docId map. Only known operations,
 * numeric ids, and nothing that is really another operation's bundled id. Operations
 * that share one bundled id are ambiguous, so a harvested value equal to it is
 * dropped for both, and so is any id the page returned under more than one name.
 */
export function sanitizeHarvest(
  raw: unknown,
  bundled: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return clean;
  const source = raw as Record<string, unknown>;
  const bundledIds = new Map(Object.entries(bundled));
  const seen: Array<[string, string]> = [];
  // Walk the bundled names, not the input: bounds the work and the result size.
  for (const name of bundledIds.keys()) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const value = source[name];
    if (typeof value === "string" && DOC_ID_PATTERN.test(value)) seen.push([name, value]);
  }
  for (const [name, value] of seen) {
    // One id under two names means the page's answer is not trustworthy for either.
    if (seen.filter(([, other]) => other === value).length > 1) continue;
    const belongsToOther = [...bundledIds].some(
      ([otherName, otherId]) => otherName !== name && otherId === value,
    );
    if (belongsToOther) continue;
    clean[name] = value;
  }
  return clean;
}
