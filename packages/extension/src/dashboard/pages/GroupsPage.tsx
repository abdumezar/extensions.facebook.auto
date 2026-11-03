import { useEffect, useMemo, useState } from "react";
import { GroupDiscovery } from "../components/GroupDiscovery.js";
import { useTranslation } from "react-i18next";
import { CURRENT_SESSION, type Group, type GroupLeaveResult } from "@nashir/shared";
import { loadCachedGroups, reloadGroups } from "../lib/data.js";
import { LeaveGroupsDialog } from "../components/LeaveGroupsDialog.js";
import { GroupsIncompleteNotice } from "../components/GroupsIncompleteNotice.js";
import { useStore } from "../store.js";
import {
  Button,
  Card,
  Checkbox,
  Icon,
  IconButton,
  Select,
  Snackbar,
  StatusChip,
  TextField,
} from "../ui/index.js";

export function GroupsPage() {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);
  const activeAccountId = useStore((s) => s.activeAccountId);
  const setActiveAccount = useStore((s) => s.setActiveAccount);
  const groups = useStore((s) => s.groups);
  const syncedAt = useStore((s) => s.groupsSyncedAt);
  const incomplete = useStore((s) => s.groupsIncomplete);
  const selected = useStore((s) => s.selectedGroupIds);
  const toggle = useStore((s) => s.toggleGroup);
  const setSelectedGroups = useStore((s) => s.setSelectedGroups);
  const clearSelection = useStore((s) => s.clearSelection);

  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Groups awaiting confirmation to leave; null = the dialog is closed. */
  const [leaveTargets, setLeaveTargets] = useState<Group[] | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q) || g.id.includes(q));
  }, [groups, query]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((g) => selected.has(g.id));

  // While the service worker finishes a long list in the background, pick up each batch as it
  // lands. Cache reads only — this never reaches Facebook.
  useEffect(() => {
    if (!incomplete || activeAccountId !== CURRENT_SESSION) return;
    const id = setInterval(() => void loadCachedGroups(activeAccountId), 30_000);
    return () => clearInterval(id);
  }, [incomplete, activeAccountId]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      await reloadGroups(activeAccountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Bulk-select what the current filter shows, so a search doubles as a selector. */
  function toggleAllFiltered() {
    const ids = new Set(selected);
    for (const g of filtered) {
      if (allFilteredSelected) ids.delete(g.id);
      else ids.add(g.id);
    }
    setSelectedGroups([...ids]);
  }

  return (
    <div className="space-y-4">
      <GroupDiscovery />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {accounts.length > 0 && (
            <Select
              label={t("groups.source")}
              className="w-56"
              value={activeAccountId}
              onChange={(e) => setActiveAccount(e.target.value)}
            >
              <option value={CURRENT_SESSION}>{t("content.currentSession")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          )}
          <TextField
            label={t("groups.search")}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full sm:w-64"
          />
        </div>

        <Button icon="sync" disabled={busy} onClick={() => void load()} className="mb-1">
          {busy ? t("common.loading") : t("groups.load")}
        </Button>
      </div>

      {/* Selection state and cache freshness, in one line the user can act on. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-small text-on-surface-variant">
        <StatusChip tone={selected.size > 0 ? "primary" : "neutral"}>
          {t("groups.selectedOf", { n: selected.size, total: groups.length })}
        </StatusChip>
        {filtered.length > 0 && (
          <Button variant="text" icon="select_all" onClick={toggleAllFiltered}>
            {allFilteredSelected ? t("groups.deselectShown") : t("groups.selectShown", { n: filtered.length })}
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="text" onClick={clearSelection}>
            {t("common.clear")}
          </Button>
        )}
        {selected.size > 0 && (
          <Button
            variant="outlined"
            icon="logout"
            onClick={() => setLeaveTargets(groups.filter((g) => selected.has(g.id)))}
          >
            {t("groups.leaveSelected", { n: selected.size })}
          </Button>
        )}
        <span className="ms-auto flex items-center gap-1.5">
          <Icon name="schedule" size={16} />
          {syncedAt > 0 ? new Date(syncedAt).toLocaleString() : t("home.neverSynced")}
        </span>
      </div>

      {incomplete && groups.length > 0 && (
        <GroupsIncompleteNotice count={groups.length} automatic={activeAccountId === CURRENT_SESSION} />
      )}

      {busy && groups.length === 0 ? (
        <GroupsSkeleton label={t("groups.loading")} />
      ) : filtered.length === 0 ? (
        <Card variant="filled">
          <p className="text-body-medium text-on-surface-variant">
            {groups.length === 0 ? t("groups.empty") : t("groups.noMatches")}
          </p>
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <table className="w-full">
            <caption className="sr-only">{t("groups.caption")}</caption>
            <thead className="bg-surface-container text-on-surface-variant">
              <tr className="text-label-medium">
                <th scope="col" className="w-12 p-3 text-start">
                  #
                </th>
                <th scope="col" className="w-14 p-3 text-start">
                  <span className="sr-only">{t("dashboard.selected")}</span>
                </th>
                <th scope="col" className="p-3 text-start">
                  {t("groups.title")}
                </th>
                <th scope="col" className="w-28 p-3 text-start">
                  {t("groups.members")}
                </th>
                <th scope="col" className="w-16 p-3 text-start">
                  <span className="sr-only">{t("groups.leaveColumn")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g, i) => (
                <tr
                  key={g.id}
                  className="border-t border-outline-variant transition-colors duration-short2 hover:bg-surface-container-low"
                >
                  <td className="p-3 text-body-small text-on-surface-variant">{i + 1}</td>
                  <td className="p-1">
                    <Checkbox
                      checked={selected.has(g.id)}
                      onCheckedChange={() => toggle(g.id)}
                      label={g.name}
                    />
                  </td>
                  {/* Row header: the group name is what identifies this row. */}
                  <th scope="row" className="p-3 text-start font-normal">
                    <bdi className="text-body-medium text-on-surface">{g.name}</bdi>
                    <span className="block text-body-small text-on-surface-variant" dir="ltr">
                      {g.id}
                    </span>
                  </th>
                  <td className="p-3 text-body-small text-on-surface-variant" dir="ltr">
                    {g.memberCount != null ? g.memberCount.toLocaleString() : "—"}
                  </td>
                  <td className="p-1">
                    <IconButton
                      icon="logout"
                      label={t("groups.leaveOne", { name: g.name })}
                      onClick={() => setLeaveTargets([g])}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {leaveTargets && leaveTargets.length > 0 && (
        <LeaveGroupsDialog
          accountId={activeAccountId}
          targets={leaveTargets}
          onClose={() => setLeaveTargets(null)}
          onDone={(results) => setNotice(summarize(t, results))}
        />
      )}

      {/* One snackbar slot: an error the user needs to act on outranks a summary. */}
      {error ? (
        <Snackbar
          message={error}
          onDismiss={() => setError(null)}
          dismissLabel={t("common.dismiss")}
          actionLabel={t("common.retry")}
          onAction={() => void load()}
        />
      ) : (
        <Snackbar
          message={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t("common.dismiss")}
          durationMs={8000}
        />
      )}
    </div>
  );
}

/**
 * One line covering every outcome of a leave batch. Deletions and failures are named
 * separately from plain leaves — "left 5 groups" would quietly hide that two of them
 * no longer exist for anyone.
 */
function summarize(t: (k: string, o?: Record<string, unknown>) => string, results: GroupLeaveResult[]): string {
  const count = (outcome: GroupLeaveResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  return (
    [
      ["left", "leave.resultLeft"],
      ["deleted", "leave.resultDeleted"],
      ["failed", "leave.resultFailed"],
      ["skipped", "leave.resultSkipped"],
    ] as const
  )
    .map(([outcome, key]) => (count(outcome) > 0 ? t(key, { n: count(outcome) }) : null))
    .filter(Boolean)
    .join(" ");
}

/**
 * A list is a content block, so it gets a shape-matching skeleton rather than a
 * spinner — the layout stays put and the wait reads as shorter.
 */
function GroupsSkeleton({ label }: { label: string }) {
  return (
    <Card flush className="overflow-hidden" aria-busy="true" aria-label={label}>
      <div className="h-11 bg-surface-container" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 border-t border-outline-variant p-3">
          <div className="h-4 w-4 animate-pulse rounded-xs bg-surface-container-highest" />
          <div className="h-5 w-5 animate-pulse rounded-xs bg-surface-container-highest" />
          <div
            className="h-4 flex-1 animate-pulse rounded-xs bg-surface-container-highest"
            // Staggered widths so the placeholder reads as a list, not a grid.
            style={{ maxWidth: `${70 - i * 8}%` }}
          />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </Card>
  );
}
