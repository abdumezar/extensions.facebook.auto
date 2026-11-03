import { useCallback, useEffect, useMemo, useState } from "react";
import { saveFile } from "../lib/download.js";
import { useTranslation } from "react-i18next";
import { CURRENT_SESSION, type AnalyticsRange, type AnalyticsReport, type PostEvent } from "@nashir/shared";
import { useStore } from "../store.js";
import { rpc } from "../lib/rpc.js";
import { formatLatency, formatTimestamp } from "../lib/format.js";
import { PostVolumeChart, PostVolumeTable } from "../components/PostVolumeChart.js";
import {
  Button,
  Card,
  Dialog,
  Icon,
  LinearProgress,
  SegmentedButton,
  Select,
  StatusChip,
  cn,
  type IconName,
  type StatusTone,
} from "../ui/index.js";

const RANGES: AnalyticsRange[] = ["24h", "7d", "30d", "all"];

/**
 * What actually happened, after the fact — the counterpart to RunBar, which only knows
 * about the run in front of it. Everything here reads the append-only event log, so it
 * survives service worker eviction, campaign deletion, and browser restarts.
 */
export function AnalyticsPage() {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);

  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [accountId, setAccountId] = useState<string>("");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const res = await rpc<AnalyticsReport>({
      type: "GET_ANALYTICS",
      range,
      ...(accountId ? { accountId } : {}),
    });
    if (res.ok && res.data) {
      setReport(res.data);
      setError(null);
    } else {
      setError(res.error ?? t("analytics.loadFailed"));
    }
    setBusy(false);
  }, [range, accountId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = useMemo(() => accountLabeller(accounts, t), [accounts, t]);

  async function download(format: "csv" | "json") {
    const res = await rpc<{ content: string; format: string }>({ type: "EXPORT_ANALYTICS", format });
    if (!res.ok || !res.data) {
      setError(res.error ?? t("analytics.exportFailed"));
      return;
    }
    saveFile(res.data.content, `nashir-analytics.${format}`, format);
  }

  async function clearLog() {
    setConfirmClear(false);
    const res = await rpc({ type: "CLEAR_ANALYTICS" });
    if (!res.ok) setError(res.error ?? t("analytics.clearFailed"));
    await load();
  }

  const summary = report?.summary;
  const empty = report != null && report.totalEvents === 0;

  return (
    <div className="space-y-6">
      {/* One filter row, above everything it scopes — never per-card controls. */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedButton
          label={t("analytics.range")}
          value={range}
          onValueChange={setRange}
          options={RANGES.map((r) => ({ value: r, label: t(`analytics.range_${r}`) }))}
        />

        {report && report.accountIds.length > 1 && (
          <Select
            label={t("analytics.account")}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="min-w-[13rem]"
          >
            <option value="">{t("analytics.allAccounts")}</option>
            {report.accountIds.map((id) => (
              <option key={id} value={id}>
                {nameFor(id)}
              </option>
            ))}
          </Select>
        )}

        <Button variant="text" icon="refresh" disabled={busy} onClick={() => void load()}>
          {t("common.refresh")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-body-medium text-error">
          {error}
        </p>
      )}

      {empty ? (
        <EmptyState />
      ) : (
        // Refetching holds the previous render at reduced opacity rather than
        // collapsing to a skeleton — no layout jump between ranges.
        <div className={cn("space-y-6 transition-opacity", busy && report && "opacity-60")}>
          {summary && report && (
            <>
              <SuccessCard
                rate={summary.successRate}
                published={summary.published}
                total={summary.total}
              />

              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat label={t("analytics.total")} value={summary.total} icon="bar_chart" />
                <Stat
                  label={t("analytics.status_pending")}
                  value={summary.pendingApproval + summary.submitted}
                  icon="hourglass_empty"
                />
                <Stat label={t("analytics.status_failed")} value={summary.failed} icon="error" />
                <Stat
                  label={t("analytics.medianLatency")}
                  value={summary.medianLatencyMs > 0 ? formatLatency(summary.medianLatencyMs) : "—"}
                  icon="speed"
                />
              </div>

              <Card variant="filled" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-title-medium text-on-surface">{t("analytics.chartTitle")}</h2>
                  <Button
                    variant="text"
                    icon={asTable ? "monitoring" : "list_alt"}
                    onClick={() => setAsTable((v) => !v)}
                  >
                    {asTable ? t("analytics.showChart") : t("analytics.showTable")}
                  </Button>
                </div>

                {asTable ? (
                  <PostVolumeTable series={report.series} bucketMs={report.bucketMs} />
                ) : (
                  <PostVolumeChart series={report.series} bucketMs={report.bucketMs} />
                )}
              </Card>

              {Object.keys(summary.perAccount).length > 1 && (
                <PerAccountTable rollups={summary.perAccount} nameFor={nameFor} />
              )}

              <RecentTable events={report.recent} nameFor={nameFor} />
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
        <Button variant="outlined" icon="download" onClick={() => void download("csv")}>
          {t("analytics.exportCsv")}
        </Button>
        <Button variant="outlined" icon="download" onClick={() => void download("json")}>
          {t("analytics.exportJson")}
        </Button>
        <Button variant="text" icon="delete" className="ms-auto" onClick={() => setConfirmClear(true)}>
          {t("analytics.clear")}
        </Button>
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        headline={t("analytics.clearConfirmTitle")}
        icon="warning"
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmClear(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void clearLog()}>{t("analytics.clear")}</Button>
          </>
        }
      >
        <p className="text-body-medium text-on-surface-variant">{t("analytics.clearConfirmBody")}</p>
      </Dialog>
    </div>
  );
}

/**
 * The one hero figure on the page. Success here means PUBLISHED — a post sitting in a
 * group's approval queue has not reached anybody yet, and counting it as a win is how
 * a tool ends up reporting 100% while nothing is live.
 */
function SuccessCard({ rate, published, total }: { rate: number; published: number; total: number }) {
  const { t } = useTranslation();
  const pct = Math.round(rate * 100);
  const tone: StatusTone = total === 0 ? "neutral" : pct >= 80 ? "success" : pct >= 50 ? "warning" : "error";

  return (
    <Card variant="filled" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-label-large text-on-surface-variant">{t("analytics.successRate")}</div>
          <div className="text-display-small text-on-surface">{total === 0 ? "—" : `${pct}%`}</div>
        </div>
        <StatusChip tone={tone}>{t("analytics.publishedOf", { published, total })}</StatusChip>
      </div>
      <LinearProgress value={pct} label={t("analytics.successRate")} />
    </Card>
  );
}

function PerAccountTable({
  rollups,
  nameFor,
}: {
  rollups: Record<string, { total: number; published: number; pending: number; failed: number }>;
  nameFor: (id: string) => string;
}) {
  const { t } = useTranslation();
  const rows = Object.entries(rollups).sort((a, b) => b[1].total - a[1].total);

  return (
    <Card variant="filled" className="space-y-3">
      <h2 className="text-title-medium text-on-surface">{t("analytics.perAccount")}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-body-medium">
          <thead>
            <tr className="border-b border-outline-variant text-label-medium text-on-surface-variant">
              <th scope="col" className="py-2 text-start font-normal">
                {t("analytics.account")}
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                {t("analytics.total")}
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                {t("analytics.status_published")}
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                {t("analytics.status_pending")}
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                {t("analytics.status_failed")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, r]) => (
              <tr key={id} className="border-b border-outline-variant/50">
                <th scope="row" className="py-2 text-start font-normal text-on-surface">
                  <bdi>{nameFor(id)}</bdi>
                </th>
                <td className="py-2 text-end tabular-nums text-on-surface">{r.total}</td>
                <td className="py-2 text-end tabular-nums text-on-surface">{r.published}</td>
                <td className="py-2 text-end tabular-nums text-on-surface">{r.pending}</td>
                <td className="py-2 text-end tabular-nums text-on-surface">{r.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUS_TONE: Record<string, StatusTone> = {
  published: "success",
  pending_approval: "warning",
  submitted: "warning",
  failed: "error",
};

function RecentTable({ events, nameFor }: { events: PostEvent[]; nameFor: (id: string) => string }) {
  const { t, i18n } = useTranslation();
  if (events.length === 0) return null;

  return (
    <Card variant="filled" className="space-y-3">
      <h2 className="text-title-medium text-on-surface">{t("analytics.recent")}</h2>
      <ul className="divide-y divide-outline-variant/50">
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <StatusChip tone={STATUS_TONE[e.status] ?? "neutral"}>
              {t(`analytics.event_${e.status}`)}
            </StatusChip>
            <bdi className="min-w-0 flex-1 truncate text-body-medium text-on-surface">{e.groupName}</bdi>
            <span className="text-body-small text-on-surface-variant">
              <bdi>{nameFor(e.accountId)}</bdi>
            </span>
            <time
              dateTime={new Date(e.ts).toISOString()}
              className="text-body-small tabular-nums text-on-surface-variant"
            >
              <bdi>{formatTimestamp(e.ts, i18n.language)}</bdi>
            </time>
            {e.permalink && (
              <a
                href={e.permalink}
                target="_blank"
                rel="noreferrer"
                className="text-label-large text-primary"
              >
                {t("analytics.openPost")}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <Card variant="filled" className="flex flex-col items-center gap-2 py-10 text-center">
      <Icon name="monitoring" size={32} className="text-on-surface-variant" />
      <p className="text-title-small text-on-surface">{t("analytics.empty")}</p>
      <p className="max-w-md text-body-medium text-on-surface-variant">{t("analytics.emptyHint")}</p>
    </Card>
  );
}

function Stat({ label, value, icon }: { label: string; value: string | number; icon: IconName }) {
  return (
    <Card variant="filled">
      <div className="flex items-center gap-2 text-on-surface-variant">
        <Icon name={icon} size={18} />
        <span className="text-label-medium">{label}</span>
      </div>
      <div className="mt-2 text-headline-small text-on-surface">{value}</div>
    </Card>
  );
}

/**
 * Events store an account id, which may name an account the user has since removed —
 * the log outlives the account list, so an unknown id has to stay readable.
 */
function accountLabeller(
  accounts: { id: string; label?: string; profile?: { name?: string } }[],
  t: (k: string) => string,
): (id: string) => string {
  const byId = new Map(accounts.map((a) => [a.id, a.profile?.name ?? a.label ?? a.id]));
  return (id) => (id === CURRENT_SESSION ? t("analytics.currentSession") : (byId.get(id) ?? id));
}
