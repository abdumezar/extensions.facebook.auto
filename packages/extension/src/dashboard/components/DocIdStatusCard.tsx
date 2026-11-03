import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { DocIdRow } from "@nashir/shared";
import { formatTimestamp } from "../lib/format.js";
import { Card, Icon, StatusChip } from "../ui/index.js";

type Hint = "feed" | "groups" | "composer" | "comments" | "reactions" | "leave";

/**
 * The Facebook screen that makes the page load each operation's code, which is when
 * the extension gets to read the id Facebook is using for it. Keyed by friendlyName.
 */
export const DOC_ID_HINTS: Record<string, Hint> = {
  ComposerStoryCreateMutation: "composer",
  GroupsCometJoinsRootQuery: "groups",
  GroupsCometAllJoinedGroupsSectionPaginationQuery: "groups",
  GroupsCometLeaveDialogQuery: "leave",
  useGroupLeaveMutation: "leave",
  CometUFIReactionsDialogQuery: "reactions",
  CometUFIReactionsDialogTabContentRefetchQuery: "reactions",
  CommentListComponentsRootQuery: "comments",
  CommentsListComponentsPaginationQuery: "comments",
};

/**
 * Names come from the service worker; one that is not in the map still gets a sensible
 * nudge. "feed" is only that fallback: the home page may not load any of these
 * operations, so it is a generic starting point, not a promise that it teaches an id.
 */
export function hintFor(name: string): Hint {
  return Object.prototype.hasOwnProperty.call(DOC_ID_HINTS, name) ? DOC_ID_HINTS[name]! : "feed";
}

const TH = "py-2 text-start font-normal";

/**
 * Which Facebook operations are running on an id the extension has seen Facebook use,
 * and which are still on the one it shipped with.
 *
 * An operation on its shipped id is not broken — it is just unverified. When one of
 * them stops working this is the first place to look, and the hint says which Facebook
 * screen to open once so the extension can learn the current id.
 */
export function DocIdStatusCard({ rows }: { rows: DocIdRow[] }) {
  const { t, i18n } = useTranslation();
  const titleId = useId();

  return (
    <Card variant="filled" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="sync" size={18} />
        <h2 id={titleId} className="text-label-large font-bold">
          {t("docIds.title")}
        </h2>
      </div>
      <p className="text-body-small text-on-surface-variant">{t("docIds.intro")}</p>

      <div className="overflow-x-auto">
        <table className="w-full text-body-medium" aria-labelledby={titleId}>
          <thead>
            <tr className="border-b border-outline-variant text-label-medium text-on-surface-variant">
              <th scope="col" className={TH}>
                {t("docIds.operation")}
              </th>
              <th scope="col" className={TH}>
                {t("docIds.active")}
              </th>
              <th scope="col" className={TH}>
                {t("docIds.source")}
              </th>
              <th scope="col" className={TH}>
                {t("docIds.lastSeen")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-outline-variant/50 align-top">
                <th scope="row" className="py-2 pe-3 text-start font-normal text-on-surface">
                  {/* Identifiers are Latin; without dir the surrounding Arabic layout
                      would reorder the camel-case runs. */}
                  <code dir="ltr" className="inline-block break-all">
                    {r.name}
                  </code>
                  {r.source === "bundled" && (
                    <div className="text-body-small text-on-surface-variant">
                      {t(`docIds.hint_${hintFor(r.name)}`)}
                    </div>
                  )}
                </th>
                <td className="py-2 pe-3 tabular-nums">
                  <code dir="ltr" className="inline-block">
                    {r.active}
                  </code>
                </td>
                <td className="py-2 pe-3">
                  <StatusChip
                    tone={r.source === "learned" ? "success" : "neutral"}
                    icon={r.source === "learned" ? "check_circle" : undefined}
                  >
                    {t(`docIds.source_${r.source}`)}
                  </StatusChip>
                </td>
                <td className="py-2 text-on-surface-variant">
                  {r.seenAt != null ? (
                    <bdi>{formatTimestamp(r.seenAt, i18n.language)}</bdi>
                  ) : (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{t("docIds.notLearned")}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
