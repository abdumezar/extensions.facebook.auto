import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore, resolveGroupIds } from "../store.js";
import { rpc, call } from "../lib/rpc.js";
import { CURRENT_SESSION, type Campaign, type RunSnapshot, type PostResult, type RiskLevel } from "@nashir/shared";
import { estimateRunMs, manualEffortMs, assessRisk } from "../../engine/SafetyPolicy.js";
import { formatDuration } from "../lib/format.js";
import { SummaryModal } from "./SummaryModal.js";
import { CheckpointActions } from "./CheckpointBanner.js";
import { CooldownNotice, cooldownAction } from "./CooldownNotice.js";
import { RiskModal } from "./RiskModal.js";
import { Button, Dialog, Icon, StatusChip, type IconName, type StatusTone } from "../ui/index.js";
import { cn } from "../ui/cn.js";

const ACTIVE = new Set(["running", "paused", "safety_break", "cooldown"]);

/**
 * Risk maps onto the harmonised semantic roles rather than raw stoplight colours.
 * `risky` and `dangerous` share the error role; the label text carries the
 * distinction, and both warrant the same visual weight.
 */
const RISK_TONE: Record<RiskLevel, StatusTone> = {
  safe: "success",
  moderate: "warning",
  risky: "error",
  dangerous: "error",
};

export function RunBar() {
  const { t } = useTranslation();
  const draft = useStore((s) => s.draft);
  const selected = useStore((s) => s.selectedGroupIds);
  const selectedAccountIds = useStore((s) => s.selectedAccountIds);
  const snapshot = useStore((s) => s.snapshot);
  const setSnapshot = useStore((s) => s.setSnapshot);
  const fbTabCount = useStore((s) => s.fbTabCount);
  const setFbTabCount = useStore((s) => s.setFbTabCount);

  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [summary, setSummary] = useState<{ snap: RunSnapshot; results: PostResult[] } | null>(null);
  const [riskOpen, setRiskOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const lastStatus = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await rpc<RunSnapshot | null>({ type: "GET_RUN_SNAPSHOT" });
      if (!alive) return;
      const snap = (res.data as RunSnapshot | null) ?? null;
      setSnapshot(snap);
      if (snap && snap.status === "done" && lastStatus.current && lastStatus.current !== "done" && snap.total > 0) {
        const results = await call<PostResult[]>({ type: "GET_RUN_RESULTS" }).catch(() => []);
        if (alive) setSummary({ snap, results });
      }
      lastStatus.current = snap?.status ?? null;
      const tabs = await rpc<{ count: number }>({ type: "COUNT_FB_TABS" });
      if (alive && tabs.data) setFbTabCount((tabs.data as { count: number }).count);
    };
    void tick();
    const poll = setInterval(tick, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [setSnapshot, setFbTabCount]);

  const groupIds = useMemo(
    () => resolveGroupIds(selected, draft.manualGroupIds),
    [draft.manualGroupIds, selected],
  );

  const variations = draft.variations.map((v) => v.trim()).filter(Boolean);
  const accountIds = selectedAccountIds.size ? [...selectedAccountIds] : [CURRENT_SESSION];
  const multiAccount = accountIds.some((id) => id !== CURRENT_SESSION);
  const totalPosts = groupIds.length * accountIds.length;
  const canStart = variations.length > 0 && groupIds.length > 0 && !busy;
  const isActive = snapshot && ACTIVE.has(snapshot.status);

  const estMs = estimateRunMs(totalPosts, draft.delay, draft.safetyBreak);
  // Active hands-on clicking effort the run saves you — the campaign runs unattended,
  // so this is the manual effort avoided, not wall-clock minus run time.
  const savedMs = manualEffortMs(totalPosts);
  const risk = assessRisk(draft.delay, totalPosts);

  async function beginRun() {
    setRiskOpen(false);
    setBusy(true);
    const d = useStore.getState().draft; // fresh (safe-delay may have just been applied)
    const gids = resolveGroupIds(useStore.getState().selectedGroupIds, d.manualGroupIds);
    const sel = useStore.getState().selectedAccountIds;
    const ts = Date.now();
    const campaign: Campaign = {
      id: `c_${ts}`,
      name: "Campaign",
      accountIds: sel.size ? [...sel] : [CURRENT_SESSION],
      groupIds: gids,
      variations: d.variations.map((v) => v.trim()).filter(Boolean),
      media: d.media,
      linkUrl: d.linkUrl,
      firstComment: d.firstComment.trim() || undefined,
      delay: d.delay,
      safetyBreak: d.safetyBreak,
      antiDetection: d.antiDetection,
      createdAt: ts,
      updatedAt: ts,
    };
    await rpc({ type: "RUN_CAMPAIGN", campaign });
    setBusy(false);
  }

  function onStartClick() {
    if (risk.risky) setRiskOpen(true);
    else void beginRun();
  }

  function applySafeAndRun() {
    const r = risk.recommendation;
    useStore.getState().updateDraft({
      delay: { ...draft.delay, minSeconds: r.minSeconds, maxSeconds: r.maxSeconds },
    });
    void beginRun();
  }

  if (!isActive) {
    return (
      <>
        {multiAccount && fbTabCount > 0 && (
          <div className="flex items-center gap-2 bg-warning-container px-6 py-2 text-body-small text-on-warning-container">
            <Icon name="warning" size={18} />
            {t("run.closeTabs")} ({fbTabCount})
          </div>
        )}

        <div className="flex items-center justify-between gap-4 bg-surface-container px-6 py-3">
          {canStart ? (
            <div className="flex flex-wrap items-center gap-4">
              <Metric icon="schedule" label={t("estimate.runtime")} value={formatDuration(estMs)} />
              <Metric
                icon="bolt"
                label={t("estimate.saved")}
                value={formatDuration(savedMs)}
                valueClass="text-success"
              />
              <Metric icon="groups" label={t("estimate.groups")} value={String(totalPosts)} />
              <StatusChip tone={RISK_TONE[risk.recommendation.riskLevel]}>
                {t(`risk.${risk.recommendation.riskLevel}`)}
              </StatusChip>
            </div>
          ) : (
            <span className="text-body-medium text-on-surface-variant">{t("run.needContent")}</span>
          )}

          <Button icon="play_arrow" disabled={!canStart} onClick={onStartClick}>
            {busy ? t("run.starting") : t("run.start")}
          </Button>
        </div>

        {riskOpen && (
          <RiskModal
            delay={draft.delay}
            recommendation={risk.recommendation}
            onApplySafe={applySafeAndRun}
            onPostAnyway={() => void beginRun()}
            onCancel={() => setRiskOpen(false)}
          />
        )}
        {summary && (
          <SummaryModal snap={summary.snap} results={summary.results} onClose={() => setSummary(null)} />
        )}
      </>
    );
  }

  const s = snapshot!;
  const secsToNext = Math.max(0, Math.round((s.nextWakeAt - now) / 1000));
  const cooling = s.status === "cooldown";
  const action = cooldownAction(s, now);

  const statusLabel = cooling
    ? t("run.cooldown")
    : s.status === "running"
      ? t("run.running")
      : s.status === "paused"
        ? t("run.paused")
        : t("run.break");

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-6 py-3",
        cooling
          ? "bg-warning-container text-on-warning-container"
          : "bg-primary-container text-on-primary-container",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 text-body-medium",
          cooling ? "text-on-warning-container" : "text-on-primary-container",
        )}
      >
        {cooling ? (
          <Icon name="hourglass_empty" size={18} />
        ) : (
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-primary" />
        )}
        <b className="text-label-large">{statusLabel}</b>
        <span>
          {s.done} {t("run.of")} {s.total}
        </span>

        <StatusChip tone="success" icon="check_circle">
          {s.published}
        </StatusChip>
        {s.pending > 0 && (
          <StatusChip tone="warning" icon="hourglass_empty">
            {s.pending}
          </StatusChip>
        )}
        {s.failed > 0 && (
          <StatusChip tone="error" icon="cancel">
            {s.failed}
          </StatusChip>
        )}

        {(s.status === "running" || s.status === "safety_break") && secsToNext > 0 && (
          <span>
            {t("run.next")} {secsToNext}s
          </span>
        )}

        {cooling && <CooldownNotice snap={s} now={now} />}
        {s.lastGroupName && (
          <span className="max-w-[160px] truncate">
            · <bdi>{s.lastGroupName}</bdi>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {s.status === "running" ? (
          <Button variant="text" icon="pause" onClick={() => void rpc({ type: "PAUSE_RUN" })}>
            {t("common.pause")}
          </Button>
        ) : cooling ? (
          /*
           * While Facebook is still blocking, the honest primary action is none at all.
           * Resuming early is offered, but behind a confirmation: a one-click Resume
           * during a live block is the single worst button this feature could ship,
           * because taking it is the documented way to make the block last longer.
           */
          action === "checkpoint" ? (
            <CheckpointActions />
          ) : action === "resume" ? (
            <Button icon="play_arrow" onClick={() => void rpc({ type: "RESUME_RUN" })}>
              {t("common.resume")}
            </Button>
          ) : action === "force" ? (
            <Button variant="text" icon="play_arrow" onClick={() => setForceOpen(true)}>
              {t("throttle.resumeAnyway")}
            </Button>
          ) : null
        ) : (
          <Button variant="text" icon="play_arrow" onClick={() => void rpc({ type: "RESUME_RUN" })}>
            {t("common.resume")}
          </Button>
        )}
        <Button
          variant="text"
          icon="stop"
          className="text-error"
          onClick={() => void rpc({ type: "STOP_RUN" })}
        >
          {t("common.stop")}
        </Button>
      </div>

      <Dialog
        open={forceOpen}
        onClose={() => setForceOpen(false)}
        headline={t("throttle.resumeAnywayTitle")}
        icon="warning"
        actions={
          <>
            <Button variant="text" onClick={() => setForceOpen(false)}>
              {t("throttle.keepWaiting")}
            </Button>
            <Button
              className="text-error"
              variant="text"
              onClick={() => {
                setForceOpen(false);
                void rpc({ type: "RESUME_RUN", force: true });
              }}
            >
              {t("throttle.resumeAnyway")}
            </Button>
          </>
        }
      >
        <p>{t("throttle.resumeAnywayWarn")}</p>
        {s.cooldownReason && (
          <p className="mt-3 text-body-small text-on-surface-variant">
            {t("throttle.saidByFacebook")}: <bdi>{s.cooldownReason}</bdi>
          </p>
        )}
      </Dialog>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  valueClass,
}: {
  icon: IconName;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-label-medium">
      <Icon name={icon} size={18} className="text-on-surface-variant" />
      <span className="text-on-surface-variant">{label}</span>
      <b className={valueClass ?? "text-on-surface"}>{value}</b>
    </span>
  );
}
