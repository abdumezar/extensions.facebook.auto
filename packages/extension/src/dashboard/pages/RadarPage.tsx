import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LeadMatch, RadarConfig } from "../../engine/LeadRadarService.js";
import { useStore } from "../store.js";
import { rpc } from "../lib/rpc.js";
import {
  Button,
  Card,
  Checkbox,
  FilterChip,
  Icon,
  StatusChip,
  Switch,
  TextField,
} from "../ui/index.js";

interface RadarView {
  config: RadarConfig;
  matches: LeadMatch[];
  lastSweepAt: number | null;
  unsupported: boolean;
  /** The recipe carries a group-feed doc_id. False = waiting on a capture. */
  supported: boolean;
}

/** The watch list is capped by the call budget: every watched group is a feed read per sweep. */
const MAX_WATCHED = 25;

export function RadarPage() {
  const { t } = useTranslation();
  const groups = useStore((s) => s.groups);
  const [view, setView] = useState<RadarView | null>(null);
  const [keywords, setKeywords] = useState("");
  const [excludes, setExcludes] = useState("");

  const load = useCallback(async () => {
    const res = await rpc<RadarView>({ type: "GET_RADAR" });
    if (res.ok && res.data) {
      setView(res.data);
      const rule = res.data.config.rules[0];
      if (rule) {
        setKeywords(rule.keywords.join(", "));
        setExcludes((rule.excludeKeywords ?? []).join(", "));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configure = async (patch: Record<string, unknown>) => {
    await rpc({ type: "CONFIGURE_RADAR", ...patch } as never);
    await load();
  };

  const saveRule = async () => {
    const kw = splitList(keywords);
    if (kw.length === 0) return;
    await configure({
      rules: [
        {
          id: "primary",
          groupIds: [],
          keywords: kw,
          excludeKeywords: splitList(excludes),
          minScore: 50,
          enabled: true,
        },
      ],
    });
  };

  if (!view) {
    return (
      <Card variant="filled">
        <p className="text-body-medium text-on-surface-variant">{t("common.loading")}</p>
      </Card>
    );
  }

  const watched = new Set(view.config.watchedGroupIds);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-title-large text-on-surface">{t("radar.title")}</h2>
            <p className="mt-1 text-body-medium text-on-surface-variant">{t("radar.subtitle")}</p>
          </div>
          <Switch
            checked={view.config.enabled}
            disabled={!view.supported}
            onCheckedChange={(enabled) => void configure({ enabled })}
            label={t("radar.enable")}
          />
        </div>

        {/*
          Same contract as the link preview: a missing doc_id is a known state, not a
          fault, and saying so beats a switch that silently does nothing.
        */}
        {!view.supported && (
          <p className="mt-3 rounded-lg bg-surface-container p-3 text-body-medium text-on-surface-variant">
            {t("radar.unsupported")}
          </p>
        )}

        {view.lastSweepAt && (
          <p className="mt-3 text-body-small text-on-surface-variant">
            {t("radar.lastSweep", { time: new Date(view.lastSweepAt).toLocaleString() })}
          </p>
        )}
      </Card>

      <Card>
        <h3 className="text-title-medium text-on-surface">{t("radar.rule.title")}</h3>
        <p className="mt-1 text-body-medium text-on-surface-variant">{t("radar.rule.desc")}</p>

        <div className="mt-4 flex flex-col gap-4">
          <TextField
            label={t("radar.rule.keywords")}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            dir="auto"
          />
          <TextField
            label={t("radar.rule.excludes")}
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
            dir="auto"
          />
          <div>
            <Button variant="filled" onClick={() => void saveRule()} disabled={!keywords.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-title-medium text-on-surface">{t("radar.watch.title")}</h3>
          <span className="text-body-small text-on-surface-variant">
            {t("radar.watch.count", { n: watched.size, max: MAX_WATCHED })}
          </span>
        </div>
        <p className="mt-1 text-body-medium text-on-surface-variant">{t("radar.watch.desc")}</p>

        <div className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
          {groups.length === 0 && (
            <p className="text-body-medium text-on-surface-variant">{t("radar.watch.noGroups")}</p>
          )}
          {groups.map((g) => {
            const on = watched.has(g.id);
            return (
              <Checkbox
                key={g.id}
                checked={on}
                // The cap is enforced by disabling the unticked ones, not by silently
                // dropping the overflow on save.
                disabled={!on && watched.size >= MAX_WATCHED}
                onCheckedChange={(next) => {
                  const ids = next
                    ? [...watched, g.id]
                    : [...watched].filter((id) => id !== g.id);
                  void configure({ watchedGroupIds: ids });
                }}
                label={g.name}
              />
            );
          })}
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-title-medium text-on-surface">
            {t("radar.leads.title", { n: view.matches.length })}
          </h3>
          <div className="flex items-center gap-2">
            <FilterChip
              selected={view.config.notify}
              onSelectedChange={(notify) => void configure({ notify })}
            >
              {t("radar.notify")}
            </FilterChip>
            {view.matches.length > 0 && (
              <Button
                variant="text"
                icon="delete"
                onClick={async () => {
                  await rpc({ type: "CLEAR_LEADS" });
                  await load();
                }}
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        </div>

        {view.matches.length === 0 ? (
          <p className="mt-3 text-body-medium text-on-surface-variant">{t("radar.leads.empty")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {view.matches.map((m) => (
              <Lead
                key={m.id}
                m={m}
                t={t}
                onHandled={async () => {
                  await rpc({ type: "MARK_LEAD_HANDLED", id: m.id });
                  await load();
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Lead({
  m,
  t,
  onHandled,
}: {
  m: LeadMatch;
  t: (k: string, o?: any) => string;
  onHandled: () => Promise<void>;
}) {
  return (
    <li
      className={`rounded-lg border border-outline-variant p-3 ${m.handled ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={m.score >= 75 ? "success" : "warning"}>{m.score}</StatusChip>
        <span className="text-body-small text-on-surface-variant" dir="auto">
          {m.groupName}
        </span>
        {m.authorName && (
          <span className="text-body-small text-on-surface-variant" dir="auto">
            · {m.authorName}
          </span>
        )}
        {m.handled && <StatusChip tone="neutral">{t("radar.leads.handled")}</StatusChip>}
      </div>

      <p className="mt-2 text-body-medium text-on-surface" dir="auto">
        {m.text.slice(0, 400)}
      </p>

      {/* Why the operator was interrupted. A score with no reason is a score nobody trusts. */}
      <p className="mt-1 text-body-small text-on-surface-variant" dir="auto">
        {m.matched.join(", ")}
        {m.reasons.length > 0 ? ` · ${m.reasons.join(" · ")}` : ""}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {m.postUrl && (
          <a
            href={m.postUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-body-small text-primary"
          >
            {t("radar.leads.open")} <Icon name="open_in_new" size={14} />
          </a>
        )}
        {!m.handled && (
          <Button variant="text" icon="check" onClick={() => void onHandled()}>
            {t("radar.leads.markHandled")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Comma or newline separated, trimmed, empties dropped. */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
