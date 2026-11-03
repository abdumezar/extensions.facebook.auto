import type { AudienceContact, AudiencePage as AudiencePageData, ExtractionState } from "@nashir/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { whatsappLink } from "../../engine/audienceExport.js";
import { saveFile } from "../lib/download.js";
import { call, rpc } from "../lib/rpc.js";
import {
  Button,
  Card,
  Checkbox,
  FilterChip,
  Icon,
  LinearProgress,
  Select,
  Switch,
  StatusChip,
  type StatusTone,
  TextField,
  cn,
} from "../ui/index.js";

const CONSENT_KEY = "nashir:audience-consent";
const REGION_KEY = "nashir:audience-region";
const TEMPLATE_KEY = "nashir:audience-wa-template";
const POLL_MS = 1500;

/** The regions `contactExtract` can resolve a bare national number against. */
const REGIONS = [
  "SA", "AE", "EG", "JO", "KW", "QA", "BH", "OM",
  "MA", "DZ", "TN", "IQ", "LB", "SY", "PS", "TR", "YE", "LY", "SD",
] as const;

const BUSY: ExtractionState["status"][] = ["resolving", "reactors", "comments"];

export function AudiencePage() {
  const { t } = useTranslation();
  const [consented, setConsented] = useState(() => localStorage.getItem(CONSENT_KEY) === "1");

  if (!consented) return <ConsentGate onAccept={() => setConsented(true)} />;
  return <Extractor t={t} />;
}

/**
 * The one-time disclosure.
 *
 * Not a formality. This feature writes other people's names and phone numbers to
 * disk, and both the Chrome Limited Use policy and every reading of GDPR's
 * legitimate-interest test turn on the operator having been told what is collected
 * and being able to delete it. Gating the whole page is the only version of this
 * that cannot be skipped past.
 */
function ConsentGate({ onAccept }: { onAccept: () => void }) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  return (
    <Card>
      <h2 className="text-title-large text-on-surface">{t("audience.consent.title")}</h2>
      <ul className="mt-4 flex list-disc flex-col gap-2 text-body-medium text-on-surface-variant ps-5">
        <li>{t("audience.consent.point1")}</li>
        <li>{t("audience.consent.point2")}</li>
        <li>{t("audience.consent.point3")}</li>
        <li>{t("audience.consent.point4")}</li>
      </ul>
      <div className="mt-5">
        <Checkbox
          checked={checked}
          onCheckedChange={setChecked}
          label={t("audience.consent.agree")}
        />
      </div>
      <div className="mt-4">
        <Button
          variant="filled"
          disabled={!checked}
          onClick={() => {
            localStorage.setItem(CONSENT_KEY, "1");
            onAccept();
          }}
        >
          {t("audience.consent.continue")}
        </Button>
      </div>
    </Card>
  );
}

function Extractor({ t }: { t: (k: string, o?: Record<string, unknown>) => string }) {
  const [url, setUrl] = useState("");
  const [region, setRegion] = useState(() => localStorage.getItem(REGION_KEY) ?? "SA");
  const [state, setState] = useState<ExtractionState | null>(null);
  const [page, setPage] = useState<AudiencePageData>({ rows: [], total: 0 });
  const [search, setSearch] = useState("");
  const [withContactOnly, setWithContactOnly] = useState(false);
  const [template, setTemplate] = useState(() => localStorage.getItem(TEMPLATE_KEY) ?? "");
  const [hideContacted, setHideContacted] = useState(true);
  const [copied, setCopied] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const busy = !!state && BUSY.includes(state.status);

  const refreshRows = useCallback(async () => {
    const res = await rpc<AudiencePageData>({
      type: "QUERY_AUDIENCE",
      search: search || undefined,
      withContactOnly: withContactOnly || undefined,
      excludeSuppressed: hideContacted,
      limit: 500,
    });
    if (res.ok && res.data) setPage(res.data);
  }, [search, withContactOnly, hideContacted]);

  // Poll while a walk is running. The extraction outlives this tab, so the page reads
  // state rather than owning it — the same contract RunBar has with a campaign.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await rpc<ExtractionState | null>({ type: "GET_EXTRACTION_STATE" });
      if (cancelled) return;
      if (res.ok) setState(res.data ?? null);
      const running = res.data && BUSY.includes(res.data.status);
      if (running) {
        timer.current = window.setTimeout(tick, POLL_MS);
      } else {
        void refreshRows();
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refreshRows]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const start = async () => {
    setError(null);
    localStorage.setItem(REGION_KEY, region);
    const res = await rpc<ExtractionState>({
      type: "START_EXTRACTION",
      postUrl: url.trim(),
      defaultRegion: region,
    });
    if (!res.ok) {
      setError(res.error ?? t("audience.error.generic"));
      return;
    }
    setState(res.data ?? null);
    const tick = async () => {
      const s = await rpc<ExtractionState | null>({ type: "GET_EXTRACTION_STATE" });
      if (s.ok) setState(s.data ?? null);
      if (s.data && BUSY.includes(s.data.status)) {
        timer.current = window.setTimeout(tick, POLL_MS);
      } else {
        void refreshRows();
      }
    };
    timer.current = window.setTimeout(tick, POLL_MS);
  };

  /** Every number on screen, one per line — for pasting into a broadcast tool. */
  const copyNumbers = async () => {
    const numbers = [
      ...new Set(
        page.rows.flatMap((r) => r.contacts.filter((c) => c.kind === "phone").map((c) => c.value)),
      ),
    ];
    await navigator.clipboard.writeText(numbers.join("\n"));
    setCopied(numbers.length);
    window.setTimeout(() => setCopied(0), 2500);
  };

  const exportFile = async (format: "csv" | "json", phonesOnly: boolean) => {
    const data = await call<{ content: string; rows: number }>({
      type: "EXPORT_AUDIENCE",
      format,
      withContactOnly: phonesOnly || undefined,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(data.content, `nashir-audience-${stamp}.${format}`, format);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h2 className="text-title-large text-on-surface">{t("audience.title")}</h2>
        <p className="mt-1 text-body-medium text-on-surface-variant">{t("audience.subtitle")}</p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <TextField
              label={t("audience.postUrl")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              dir="ltr"
            />
          </div>
          <div className="w-full sm:w-40">
            <Select
              label={t("audience.region")}
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            >
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          {busy ? (
            <Button variant="outlined" icon="stop" onClick={() => void rpc({ type: "ABORT_EXTRACTION" })}>
              {t("common.stop")}
            </Button>
          ) : (
            <Button variant="filled" icon="search" disabled={!url.trim()} onClick={() => void start()}>
              {t("audience.extract")}
            </Button>
          )}
        </div>

        {/* The region is a guess we make on the operator's behalf — say so. */}
        <p className="mt-2 text-body-small text-on-surface-variant">{t("audience.regionHint")}</p>

        {error && (
          <p className="mt-3 text-body-medium text-error" role="alert">
            {error}
          </p>
        )}

        {state && <Progress state={state} t={t} />}
      </Card>

      <Card variant="filled">
        <h3 className="text-title-medium text-on-surface">{t("audience.wa.title")}</h3>
        <p className="mt-1 text-body-medium text-on-surface-variant">{t("audience.wa.desc")}</p>
        <div className="mt-3">
          <TextField
            label={t("audience.wa.template")}
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              localStorage.setItem(TEMPLATE_KEY, e.target.value);
            }}
            dir="auto"
          />
        </div>
        <p className="mt-1 text-body-small text-on-surface-variant">{t("audience.wa.hint")}</p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-48 flex-1">
            <TextField
              label={t("audience.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <FilterChip selected={withContactOnly} onSelectedChange={setWithContactOnly}>
            {t("audience.withContactOnly")}
          </FilterChip>
          <FilterChip selected={hideContacted} onSelectedChange={setHideContacted}>
            {t("audience.hideContacted")}
          </FilterChip>
          <div className="ms-auto flex flex-wrap gap-2">
            <Button variant="text" icon="check" onClick={() => void copyNumbers()}>
              {copied > 0 ? t("audience.copied", { n: copied }) : t("audience.copyNumbers")}
            </Button>
            <Button variant="tonal" icon="download" onClick={() => void exportFile("csv", false)}>
              {t("audience.exportPeople")}
            </Button>
            <Button variant="tonal" icon="download" onClick={() => void exportFile("csv", true)}>
              {t("audience.exportPhones")}
            </Button>
            <Button variant="text" icon="download" onClick={() => void exportFile("json", false)}>
              JSON
            </Button>
          </div>
        </div>

        <p className="mt-3 text-body-small text-on-surface-variant">
          {t("audience.rowCount", { shown: page.rows.length, total: page.total })}
        </p>

        <Table rows={page.rows} t={t} template={template} onChanged={() => void refreshRows()} />
      </Card>

      <EngagementCard t={t} region={region} />

      <DangerZone t={t} onCleared={() => void refreshRows()} />
    </div>
  );
}

/**
 * Live progress.
 *
 * `truncated` gets its own prominent line rather than a footnote. A partial
 * extraction that reads as complete is worse than a failed one, because the operator
 * acts on it and concludes the post had fewer responders than it did.
 */
function Progress({ state, t }: { state: ExtractionState; t: (k: string, o?: any) => string }) {
  const tone: Record<string, StatusTone> = {
    done: "success",
    error: "error",
    cooldown: "warning",
    unsupported: "warning",
    aborted: "warning",
  };
  const running = BUSY.includes(state.status);

  return (
    <div className="mt-4 rounded-lg bg-surface-container p-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip tone={tone[state.status] ?? "neutral"}>
          {t(`audience.status.${state.status}`)}
        </StatusChip>
        <span className="text-body-medium text-on-surface">
          {t("audience.progress", {
            found: state.found,
            withContact: state.withContact,
          })}
        </span>
        <span className="text-body-small text-on-surface-variant">
          {t("audience.pages", { reactors: state.reactorPages, comments: state.commentPages })}
          {state.totalComments !== undefined
            ? ` · ${t("audience.totalComments", { n: state.totalComments })}`
            : ""}
        </span>
      </div>

      {running && <LinearProgress className="mt-3" />}

      {state.truncated && !running && (
        <p className="mt-2 text-body-medium text-warning" role="status">
          {t("audience.truncated")}
        </p>
      )}
      {state.status === "unsupported" && (
        <p className="mt-2 text-body-medium text-on-surface-variant">{t("audience.unsupported")}</p>
      )}
      {state.status === "error" && state.message && (
        <p className="mt-2 text-body-medium text-error" dir="auto">
          {t(`audience.error.${state.message}`, { defaultValue: state.message })}
        </p>
      )}
      {state.status === "cooldown" && (
        <p className="mt-2 text-body-medium text-on-surface-variant" dir="auto">
          {state.message}
        </p>
      )}
    </div>
  );
}

function Table({
  rows,
  t,
  template,
  onChanged,
}: {
  rows: AudienceContact[];
  t: (k: string, o?: any) => string;
  template: string;
  onChanged: () => void;
}) {
  if (rows.length === 0) {
    return <p className="mt-4 text-body-medium text-on-surface-variant">{t("audience.empty")}</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-body-medium">
        <thead>
          <tr className="text-start text-label-medium text-on-surface-variant">
            <th className="p-2 text-start">{t("audience.col.person")}</th>
            <th className="p-2 text-start">{t("audience.col.contact")}</th>
            <th className="p-2 text-start">{t("audience.col.signal")}</th>
            <th className="p-2 text-start">{t("audience.col.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.id} row={r} t={t} template={template} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  row,
  t,
  template,
  onChanged,
}: {
  row: AudienceContact;
  t: (k: string, o?: any) => string;
  template: string;
  onChanged: () => void;
}) {
  const phones = row.contacts.filter((c) => c.kind === "phone");
  const emails = row.contacts.filter((c) => c.kind === "email");
  const reactions = [...new Set(row.sightings.map((s) => s.reaction).filter(Boolean))];
  const comments = row.sightings.filter((s) => s.text);

  return (
    <tr className="border-t border-outline-variant align-top">
      <td className="p-2">
        <div className="text-on-surface" dir="auto">
          {row.name}
        </div>
        {row.profileUrl && (
          <a
            href={row.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-body-small text-primary"
            dir="ltr"
          >
            {t("audience.openProfile")} <Icon name="open_in_new" size={14} />
          </a>
        )}
      </td>

      <td className="p-2">
        {phones.length === 0 && emails.length === 0 && (
          <span className="text-on-surface-variant">—</span>
        )}
        {phones.map((c) => (
          <div key={c.value} className="flex items-center gap-2">
            <span dir="ltr" className="text-on-surface">
              {c.value}
            </span>
            <ConfidenceDot confidence={c.confidence} />
            {/*
              Click-to-chat only, and never a send. Automating the send would put this
              inside WhatsApp's own automation rules; opening a prepared conversation
              for a person to review does not.

              Opening it records `contacted`, which is what stops the same lead being
              messaged again from tomorrow's extraction of the same group.
            */}
            <a
              href={whatsappLink(c.value, template || undefined, { name: row.name })}
              target="_blank"
              rel="noreferrer"
              className="text-body-small text-primary"
              onClick={() => {
                void rpc({ type: "SUPPRESS_CONTACT", id: row.id, reason: "contacted" }).then(
                  onChanged,
                );
              }}
            >
              WhatsApp
            </a>
          </div>
        ))}
        {emails.map((c) => (
          <div key={c.value} dir="ltr" className="text-on-surface">
            {c.value}
          </div>
        ))}
      </td>

      <td className="p-2">
        <div className="flex flex-wrap gap-1">
          {reactions.map((r) => (
            <StatusChip key={r} tone="neutral">
              {String(r)}
            </StatusChip>
          ))}
        </div>
        {comments.slice(0, 2).map((s) => (
          <p
            key={s.commentId}
            className="mt-1 line-clamp-2 text-body-small text-on-surface-variant"
            dir="auto"
          >
            {s.text}
          </p>
        ))}
      </td>

      <td className="p-2">
        <Button
          variant="text"
          onClick={async () => {
            await rpc({ type: "SUPPRESS_CONTACT", id: row.id, reason: "do_not_contact" });
            onChanged();
          }}
        >
          {t("audience.suppress")}
        </Button>
      </td>
    </tr>
  );
}

/** A number we inferred is not a number we were given — show which is which. */
function ConfidenceDot({ confidence }: { confidence: number }) {
  const tone =
    confidence >= 0.9 ? "bg-success" : confidence >= 0.7 ? "bg-warning" : "bg-outline";
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", tone)}
      title={`${Math.round(confidence * 100)}%`}
      aria-label={`${Math.round(confidence * 100)}%`}
    />
  );
}

/**
 * The loop that reads our own posts back.
 *
 * Lives here rather than in Settings because this is where its output lands: the
 * people who engaged with a campaign arrive in the same table as the ones extracted
 * by hand, marked as coming from our own post.
 */
function EngagementCard({ t, region }: { t: (k: string, o?: any) => string; region: string }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; due: number } | null>(null);

  useEffect(() => {
    void rpc<{ enabled: boolean; due: number }>({ type: "GET_ENGAGEMENT" }).then((r) => {
      if (r.ok && r.data) setCfg(r.data);
    });
  }, []);

  return (
    <Card variant="filled">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-title-medium text-on-surface">{t("audience.loop.title")}</h3>
          <p className="mt-1 text-body-medium text-on-surface-variant">{t("audience.loop.desc")}</p>
          {cfg && cfg.due > 0 && (
            <p className="mt-1 text-body-small text-on-surface-variant">
              {t("audience.loop.due", { n: cfg.due })}
            </p>
          )}
        </div>
        <Switch
          checked={cfg?.enabled ?? false}
          onCheckedChange={(enabled) => {
            setCfg((c) => (c ? { ...c, enabled } : { enabled, due: 0 }));
            void rpc({ type: "CONFIGURE_ENGAGEMENT", enabled, defaultRegion: region });
          }}
          label={t("audience.loop.toggle")}
        />
      </div>
    </Card>
  );
}

function DangerZone({ t, onCleared }: { t: (k: string, o?: any) => string; onCleared: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card variant="filled">
      <h3 className="text-title-medium text-on-surface">{t("audience.delete.title")}</h3>
      <p className="mt-1 text-body-medium text-on-surface-variant">{t("audience.delete.desc")}</p>
      <div className="mt-3 flex gap-2">
        {confirming ? (
          <>
            <Button
              variant="filled"
              icon="delete"
              onClick={async () => {
                await rpc({ type: "CLEAR_AUDIENCE" });
                setConfirming(false);
                onCleared();
              }}
            >
              {t("audience.delete.confirm")}
            </Button>
            <Button variant="text" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button variant="outlined" icon="delete" onClick={() => setConfirming(true)}>
            {t("audience.delete.action")}
          </Button>
        )}
      </div>
    </Card>
  );
}
