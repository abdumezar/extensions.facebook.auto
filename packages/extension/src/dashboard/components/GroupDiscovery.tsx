import type { Group } from "@nashir/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { rpc } from "../lib/rpc.js";
import { Button, Card, Checkbox, StatusChip, TextField } from "../ui/index.js";

interface JoinBudget {
  remaining: number;
  supported: boolean;
  searchSupported: boolean;
}

interface JoinResult {
  groupId: string;
  status: "joined" | "requested" | "failed" | "skipped" | "unsupported";
  error?: string;
}

/**
 * Find groups by keyword and join them.
 *
 * Joining is the single most restriction-associated action in this category, so the
 * UI is shaped to make the risk visible rather than smooth: the remaining daily
 * allowance is always on screen, results distinguish a membership from a pending
 * request, and there is no "join everything" button.
 */
export function GroupDiscovery() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [found, setFound] = useState<Group[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState<JoinBudget | null>(null);
  const [results, setResults] = useState<JoinResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void rpc<JoinBudget>({ type: "GET_JOIN_BUDGET" }).then((r) => {
      if (r.ok && r.data) setBudget(r.data);
    });
  }, [open]);

  if (!open) {
    return (
      <Button variant="text" icon="search" onClick={() => setOpen(true)}>
        {t("discover.open")}
      </Button>
    );
  }

  const search = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    const res = await rpc<{ groups: Group[]; unsupported?: boolean }>({
      type: "SEARCH_GROUPS",
      keyword: keyword.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t("discover.error"));
      return;
    }
    if (res.data?.unsupported) {
      setError(t("discover.unsupported"));
      return;
    }
    setFound(res.data?.groups ?? []);
    setPicked(new Set());
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    const res = await rpc<JoinResult[]>({ type: "JOIN_GROUPS", groupIds: [...picked] });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t("discover.error"));
      return;
    }
    setResults(res.data ?? []);
    const b = await rpc<JoinBudget>({ type: "GET_JOIN_BUDGET" });
    if (b.ok && b.data) setBudget(b.data);
  };

  return (
    <Card variant="filled" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-title-medium text-on-surface">{t("discover.title")}</h3>
        <div className="flex items-center gap-2">
          {budget && (
            <StatusChip tone={budget.remaining > 2 ? "neutral" : "warning"}>
              {t("discover.remaining", { n: budget.remaining })}
            </StatusChip>
          )}
          <Button variant="text" onClick={() => setOpen(false)}>
            {t("common.close")}
          </Button>
        </div>
      </div>

      <p className="text-body-medium text-on-surface-variant">{t("discover.desc")}</p>

      {budget && !budget.supported && (
        <p className="rounded-lg bg-surface-container p-3 text-body-medium text-on-surface-variant">
          {t("discover.unsupported")}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label={t("discover.keyword")}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="w-full sm:w-72"
          dir="auto"
        />
        <Button
          variant="tonal"
          icon="search"
          disabled={busy || keyword.trim().length < 2}
          onClick={() => void search()}
        >
          {busy ? t("common.loading") : t("discover.search")}
        </Button>
      </div>

      {found.length > 0 && (
        <>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {found.map((g) => {
              const on = picked.has(g.id);
              return (
                <Checkbox
                  key={g.id}
                  checked={on}
                  // Capped at the batch limit in the UI as well as the engine: a
                  // disabled box explains itself, a silently-dropped id does not.
                  disabled={!on && (picked.size >= 3 || (budget?.remaining ?? 0) <= picked.size)}
                  onCheckedChange={(next) => {
                    const s = new Set(picked);
                    if (next) s.add(g.id);
                    else s.delete(g.id);
                    setPicked(s);
                  }}
                  label={g.memberCount ? `${g.name} · ${g.memberCount.toLocaleString()}` : g.name}
                />
              );
            })}
          </div>

          <Button
            variant="filled"
            disabled={busy || picked.size === 0 || !budget?.supported}
            onClick={() => void join()}
          >
            {t("discover.join", { n: picked.size })}
          </Button>
        </>
      )}

      {results && (
        <ul className="flex flex-col gap-1 text-body-small">
          {results.map((r) => (
            <li key={r.groupId} className="flex items-center gap-2">
              <StatusChip
                tone={
                  r.status === "joined" ? "success" : r.status === "failed" ? "error" : "warning"
                }
              >
                {t(`discover.result.${r.status}`)}
              </StatusChip>
              <span className="text-on-surface-variant" dir="auto">
                {found.find((g) => g.id === r.groupId)?.name ?? r.groupId}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="text-body-medium text-error" role="alert" dir="auto">
          {error}
        </p>
      )}
    </Card>
  );
}
