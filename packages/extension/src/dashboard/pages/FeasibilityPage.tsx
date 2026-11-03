import { useCallback, useEffect, useMemo, useState } from "react";
import { saveFile } from "../lib/download.js";
import { useTranslation } from "react-i18next";
import type {
  Account,
  CheckId,
  CheckRecord,
  CheckVerdict,
  FeasibilityRecord,
  RampState,
  StepResult,
} from "@nashir/shared";
import { useStore } from "../store.js";
import { rpc } from "../lib/rpc.js";
import { formatLatency, formatTimestamp } from "../lib/format.js";
import { gatePassed, measuredDefaults } from "../../engine/feasibilityMath.js";
import {
  Button,
  Card,
  Dialog,
  Icon,
  NumberField,
  Select,
  StatusChip,
  TextArea,
  TextField,
  cn,
  type IconName,
  type StatusTone,
} from "../ui/index.js";

/**
 * The Phase-1 go/no-go gate, run by hand.
 *
 * Everything else in this app assumes three things that only a real Facebook account can
 * confirm: a post lands, a cookie swap round-trips cleanly, and there is a cadence
 * Facebook tolerates. This page is where the operator establishes them, against throwaway
 * accounts and groups they control, and where the result is written down.
 *
 * It is deliberately not in the sidebar — it posts for real, and it is an operator tool,
 * not an everyday feature. Settings → Diagnostics is the only way in.
 */

/** Rate ladders offered for the 1c ramp, slowest rung first. */
/**
 * Rungs, in posts per hour.
 *
 * The top of `aggressive` came down from 60 to 40 alongside the contract's own cap.
 * A rung the schema rejects is worse than an absent one — the operator only finds out
 * when the run refuses — and two posts a minute into Facebook groups was buying a
 * block rather than measuring a ceiling.
 */
const LADDERS: Record<string, number[]> = {
  gentle: [4, 8, 12],
  standard: [6, 12, 20, 30],
  aggressive: [10, 20, 30, 40],
};

export function FeasibilityPage() {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);

  const [record, setRecord] = useState<FeasibilityRecord | null>(null);
  const [busy, setBusy] = useState<CheckId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [groupId, setGroupId] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const res = await rpc<FeasibilityRecord>({ type: "GET_FEASIBILITY" });
    if (res.ok && res.data) setRecord(res.data);
    else setError(res.error ?? t("feasibility.loadFailed"));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // A ramp runs for hours on its own alarm, so the page has to poll to stay honest about
  // it. Only while one is actually in flight — there is nothing else here that moves.
  const rampRunning = record?.ramp?.status === "running";
  useEffect(() => {
    if (!rampRunning) return;
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [rampRunning, load]);

  async function runCheck(checkId: "post" | "swap", extra: Record<string, string> = {}) {
    setBusy(checkId);
    setError(null);
    const res = await rpc<CheckRecord>({
      type: "RUN_FEASIBILITY_CHECK",
      checkId,
      groupId: groupId.trim(),
      message: message.trim() || t("feasibility.defaultMessage"),
      ...extra,
    });
    if (!res.ok) setError(res.error ?? t("feasibility.runFailed"));
    setBusy(null);
    await load();
  }

  async function clearAll() {
    setConfirmClear(false);
    await rpc({ type: "CLEAR_FEASIBILITY" });
    await load();
  }

  const targetReady = groupId.trim().length > 0;
  const passed = record ? gatePassed(record) : false;

  return (
    <div className="space-y-6">
      <GateBanner record={record} passed={passed} />

      <Card variant="filled" className="space-y-4">
        <div>
          <h2 className="text-title-medium text-on-surface">{t("feasibility.target")}</h2>
          <p className="mt-1 text-body-medium text-on-surface-variant">
            {t("feasibility.targetHint")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("feasibility.groupId")}
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            inputMode="numeric"
            supportingText={t("feasibility.groupIdHint")}
          />
          <TextField
            label={t("feasibility.message")}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            supportingText={t("feasibility.messageHint")}
          />
        </div>
      </Card>

      {error && (
        <p role="alert" className="text-body-medium text-error">
          {error}
        </p>
      )}

      <CheckCard
        id="post"
        number="1a"
        check={record?.checks.post}
        action={
          <Button
            icon="play_arrow"
            disabled={!targetReady || busy != null}
            onClick={() => void runCheck("post")}
          >
            {busy === "post" ? t("feasibility.running") : t("feasibility.run")}
          </Button>
        }
      />

      <SwapCheckCard
        check={record?.checks.swap}
        accounts={accounts}
        busy={busy != null}
        running={busy === "swap"}
        targetReady={targetReady}
        onRun={(a, b) => void runCheck("swap", { accountIdA: a, accountIdB: b })}
      />

      <RampCard record={record} accounts={accounts} onChanged={load} />

      {record?.ramp?.ceilingPostsPerHour ? (
        <MeasuredDefaultsCard ceiling={record.ramp.ceilingPostsPerHour} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
        <Button variant="outlined" icon="download" disabled={!record} onClick={() => downloadReport(record!, "md")}>
          {t("feasibility.exportMd")}
        </Button>
        <Button variant="outlined" icon="download" disabled={!record} onClick={() => downloadReport(record!, "json")}>
          {t("feasibility.exportJson")}
        </Button>
        <Button variant="text" icon="delete" className="ms-auto" onClick={() => setConfirmClear(true)}>
          {t("feasibility.clear")}
        </Button>
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        headline={t("feasibility.clearConfirmTitle")}
        icon="warning"
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmClear(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void clearAll()}>{t("feasibility.clear")}</Button>
          </>
        }
      >
        <p className="text-body-medium text-on-surface-variant">{t("feasibility.clearConfirmBody")}</p>
      </Dialog>
    </div>
  );
}

/**
 * The headline the whole page exists to produce. "Not yet run" is stated as plainly as a
 * pass, because the failure mode this page was built to fix is exactly the two looking
 * alike from a distance.
 */
export function GateBanner({ record, passed }: { record: FeasibilityRecord | null; passed: boolean }) {
  const { t } = useTranslation();
  const done = record
    ? (["post", "swap", "ramp"] as CheckId[]).filter((id) => record.checks[id].verdict !== "unrun").length
    : 0;

  return (
    <Card variant="filled" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon name="science" size={24} className={passed ? "text-success" : "text-on-surface-variant"} />
          <div>
            <h1 className="text-title-large text-on-surface">{t("feasibility.title")}</h1>
            <p className="mt-1 max-w-2xl text-body-medium text-on-surface-variant">
              {t("feasibility.intro")}
            </p>
          </div>
        </div>
        <StatusChip tone={passed ? "success" : "warning"}>
          {passed ? t("feasibility.gatePassed") : t("feasibility.gateOpen", { done, total: 3 })}
        </StatusChip>
      </div>
      <p className="rounded-md bg-error-container/40 p-3 text-body-small text-on-surface">
        {t("feasibility.warning")}
      </p>
    </Card>
  );
}

const VERDICT_TONE: Record<CheckVerdict, StatusTone> = {
  unrun: "neutral",
  running: "neutral",
  pass: "success",
  partial: "warning",
  fail: "error",
};

function CheckCard({
  id,
  number,
  check,
  action,
  children,
}: {
  id: CheckId;
  number: string;
  check?: CheckRecord;
  action: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const verdict = check?.verdict ?? "unrun";

  return (
    <Card variant="filled" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-secondary-container px-2 py-0.5 text-label-medium text-on-secondary-container">
              {number}
            </span>
            <h2 className="text-title-medium text-on-surface">{t(`feasibility.check_${id}`)}</h2>
          </div>
          <p className="mt-1 max-w-2xl text-body-medium text-on-surface-variant">
            {t(`feasibility.checkDesc_${id}`)}
          </p>
        </div>
        <StatusChip tone={VERDICT_TONE[verdict]}>{t(`feasibility.verdict_${verdict}`)}</StatusChip>
      </div>

      {children}

      <div className="flex flex-wrap items-center gap-3">
        {action}
        {check?.finishedAt && (
          <span className="text-body-small text-on-surface-variant">
            <bdi>{formatTimestamp(check.finishedAt, i18n.language)}</bdi>
          </span>
        )}
      </div>

      {check && check.steps.length > 0 && <StepList steps={check.steps} />}
    </Card>
  );
}

/** 1b needs its own two account pickers, so it wraps CheckCard rather than reusing it flat. */
function SwapCheckCard({
  check,
  accounts,
  busy,
  running,
  targetReady,
  onRun,
}: {
  check?: CheckRecord;
  accounts: Account[];
  busy: boolean;
  running: boolean;
  targetReady: boolean;
  onRun: (a: string, b: string) => void;
}) {
  const { t } = useTranslation();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const ready = targetReady && a !== "" && b !== "" && a !== b;

  return (
    <CheckCard
      id="swap"
      number="1b"
      check={check}
      action={
        <Button icon="play_arrow" disabled={!ready || busy} onClick={() => onRun(a, b)}>
          {running ? t("feasibility.running") : t("feasibility.run")}
        </Button>
      }
    >
      {accounts.length < 2 ? (
        <p className="text-body-medium text-on-surface-variant">{t("feasibility.needTwoAccounts")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label={t("feasibility.accountA")} value={a} onChange={(e) => setA(e.target.value)}>
            <option value="">{t("feasibility.choose")}</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name ?? acc.label}
              </option>
            ))}
          </Select>
          <Select label={t("feasibility.accountB")} value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">{t("feasibility.choose")}</option>
            {accounts
              .filter((acc) => acc.id !== a)
              .map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name ?? acc.label}
                </option>
              ))}
          </Select>
        </div>
      )}
    </CheckCard>
  );
}

const STEP_ICON: Record<StepResult["status"], { icon: IconName; className: string }> = {
  pending: { icon: "radio_button_unchecked", className: "text-on-surface-variant" },
  running: { icon: "hourglass_empty", className: "text-on-surface-variant" },
  pass: { icon: "check_circle", className: "text-success" },
  warn: { icon: "warning", className: "text-warning" },
  fail: { icon: "error", className: "text-error" },
  skipped: { icon: "cancel", className: "text-on-surface-variant" },
};

export function StepList({ steps }: { steps: StepResult[] }) {
  const { t } = useTranslation();
  return (
    <ol className="divide-y divide-outline-variant/50 border-t border-outline-variant/50">
      {steps.map((step) => {
        const look = STEP_ICON[step.status];
        return (
          <li key={step.id} className="flex items-start gap-3 py-2">
            <Icon name={look.icon} size={18} className={cn("mt-0.5 shrink-0", look.className)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-body-medium text-on-surface">
                  {t(`feasibility.step_${step.id}`, { defaultValue: step.id })}
                </span>
                {step.latencyMs != null && step.latencyMs > 0 && (
                  <span className="text-body-small tabular-nums text-on-surface-variant">
                    <bdi>{formatLatency(step.latencyMs)}</bdi>
                  </span>
                )}
              </div>
              {/* Facebook's own words, never translated — a paraphrased error is useless. */}
              {step.detail && (
                <p className="mt-0.5 text-body-small text-on-surface-variant">
                  <bdi>{step.detail}</bdi>
                </p>
              )}
              {step.evidence && <Evidence evidence={step.evidence} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Evidence({ evidence }: { evidence: Record<string, string | number | boolean> }) {
  const entries = Object.entries(evidence).filter(([, v]) => v !== "" && v !== false);
  if (entries.length === 0) return null;

  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-1">
          <dt className="text-label-small text-on-surface-variant">{key}</dt>
          <dd className="text-label-small tabular-nums text-on-surface">
            {/*
              Only the permalink collapses to an icon — it is evidence to open, not to
              read. The rewritten origin/referer are also URLs, and hiding THOSE behind an
              icon would remove the very thing that step records.
            */}
            {key === "permalink" && typeof value === "string" ? (
              <a href={value} target="_blank" rel="noreferrer" className="text-primary">
                <Icon name="open_in_new" size={14} className="inline" />
              </a>
            ) : (
              <bdi>{String(value)}</bdi>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 1c is the only check that keeps posting after the operator walks away, so its consent
 * gate is heavier than a button: an explicit count of how many real posts it will make,
 * over how long, and the account's own name typed back before Start unlocks.
 */
function RampCard({
  record,
  accounts,
  onChanged,
}: {
  record: FeasibilityRecord | null;
  accounts: Account[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const ramp = record?.ramp;
  const live = ramp?.status === "running";

  const [accountId, setAccountId] = useState("");
  const [groupIds, setGroupIds] = useState("");
  const [ladder, setLadder] = useState<keyof typeof LADDERS>("gentle");
  const [postsPerTier, setPostsPerTier] = useState(3);
  const [cap, setCap] = useState(15);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const account = accounts.find((a) => a.id === accountId);
  const expectedName = account?.name ?? account?.label ?? "";
  const ids = groupIds.split(/\s+/).map((s) => s.trim()).filter(Boolean);

  const plan = useMemo(() => {
    const rates = LADDERS[ladder]!;
    const posts = Math.min(cap, rates.length * postsPerTier);
    // Time is the sum of each tier's own cadence, capped by the post budget.
    let hours = 0;
    let left = posts;
    for (const rate of rates) {
      const inTier = Math.min(postsPerTier, left);
      hours += inTier / rate;
      left -= inTier;
      if (left <= 0) break;
    }
    return { posts, hours, rates };
  }, [ladder, postsPerTier, cap]);

  const armed = accountId !== "" && ids.length > 0 && typed.trim() === expectedName && expectedName !== "";

  async function start() {
    setBusy(true);
    await rpc({
      type: "START_RATE_RAMP",
      accountId,
      groupIds: ids,
      message: t("feasibility.rampMessage"),
      tiers: plan.rates.map((postsPerHour) => ({ postsPerHour, posts: postsPerTier })),
      cap,
    });
    setTyped("");
    setBusy(false);
    await onChanged();
  }

  async function abort() {
    setBusy(true);
    await rpc({ type: "ABORT_RATE_RAMP" });
    setBusy(false);
    await onChanged();
  }

  return (
    <CheckCard
      id="ramp"
      number="1c"
      check={record?.checks.ramp}
      action={
        live ? (
          <Button variant="outlined" icon="stop" disabled={busy} onClick={() => void abort()}>
            {t("feasibility.abort")}
          </Button>
        ) : (
          <Button icon="play_arrow" disabled={!armed || busy} onClick={() => void start()}>
            {t("feasibility.startRamp")}
          </Button>
        )
      }
    >
      {live && ramp ? (
        <RampProgress ramp={ramp} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label={t("feasibility.rampAccount")}
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setTyped("");
              }}
              supportingText={t("feasibility.rampAccountHint")}
            >
              <option value="">{t("feasibility.choose")}</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name ?? acc.label}
                </option>
              ))}
            </Select>
            <Select
              label={t("feasibility.ladder")}
              value={ladder}
              onChange={(e) => setLadder(e.target.value as keyof typeof LADDERS)}
              supportingText={LADDERS[ladder]!.join(" → ") + " " + t("feasibility.perHour")}
            >
              {Object.keys(LADDERS).map((key) => (
                <option key={key} value={key}>
                  {t(`feasibility.ladder_${key}`)}
                </option>
              ))}
            </Select>
          </div>

          <TextArea
            label={t("feasibility.rampGroups")}
            value={groupIds}
            onChange={(e) => setGroupIds(e.target.value)}
            rows={3}
            supportingText={t("feasibility.rampGroupsHint")}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label={t("feasibility.postsPerTier")}
              value={postsPerTier}
              onValueChange={setPostsPerTier}
              min={1}
              max={20}
            />
            <NumberField label={t("feasibility.cap")} value={cap} onValueChange={setCap} min={1} max={200} />
          </div>

          {/*
            Only once there are groups to post to. Before that the sentence would promise
            "9 posts across 0 groups", which is both alarming and untrue.
          */}
          {ids.length > 0 && (
            <p className="rounded-md bg-error-container/40 p-3 text-body-small text-on-surface">
              {t("feasibility.rampConsent", {
                posts: plan.posts,
                hours: plan.hours.toFixed(1),
                groups: ids.length,
              })}
            </p>
          )}

          {accountId !== "" && (
            <TextField
              label={t("feasibility.typeToConfirm", { name: expectedName })}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              error={typed.length > 0 && typed.trim() !== expectedName ? t("feasibility.nameMismatch") : undefined}
            />
          )}
        </div>
      )}

      {!live && ramp && ramp.posts.length > 0 && <RampProgress ramp={ramp} />}
    </CheckCard>
  );
}

export function RampProgress({ ramp }: { ramp: RampState }) {
  const { t, i18n } = useTranslation();
  const tier = ramp.config.tiers[ramp.tierIndex];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-medium text-on-surface">
        <span>
          {t("feasibility.rampProgress", { done: ramp.postsDone, cap: ramp.config.cap })}
        </span>
        {tier && ramp.status === "running" && (
          <span className="text-on-surface-variant">
            {t("feasibility.rampTier", { rate: tier.postsPerHour })}
          </span>
        )}
        {ramp.ceilingPostsPerHour != null && (
          <StatusChip tone="success">
            {t("feasibility.ceiling", { rate: ramp.ceilingPostsPerHour })}
          </StatusChip>
        )}
        {ramp.status !== "running" && (
          <StatusChip tone={ramp.status === "throttled" ? "warning" : "neutral"}>
            {t(`feasibility.rampStatus_${ramp.status}`)}
          </StatusChip>
        )}
      </div>

      {ramp.nextWakeAt != null && ramp.status === "running" && (
        <p className="text-body-small text-on-surface-variant">
          {t("feasibility.nextPost")} <bdi>{formatTimestamp(ramp.nextWakeAt, i18n.language)}</bdi>
        </p>
      )}

      {ramp.posts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-body-small">
            <thead>
              <tr className="border-b border-outline-variant text-label-medium text-on-surface-variant">
                <th scope="col" className="py-1 text-start font-normal">{t("feasibility.colTime")}</th>
                {/* pe-6: right-aligned rate against left-aligned result reads as one
                    column ("12 published") without a gap between them. */}
                <th scope="col" className="py-1 pe-6 text-end font-normal">{t("feasibility.colRate")}</th>
                <th scope="col" className="py-1 text-start font-normal">{t("feasibility.colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {ramp.posts.map((post, i) => (
                <tr key={i} className="border-b border-outline-variant/50">
                  <td className="py-1 tabular-nums text-on-surface-variant">
                    <bdi>{formatTimestamp(post.at, i18n.language)}</bdi>
                  </td>
                  <td className="py-1 pe-6 text-end tabular-nums text-on-surface">{post.tierPostsPerHour}</td>
                  <td className="py-1">
                    <span className={post.throttled ? "text-error" : "text-on-surface"}>
                      <bdi>{post.throttled ? t("feasibility.throttled") : post.status}</bdi>
                    </span>
                    {post.error && (
                      <span className="ms-2 text-on-surface-variant">
                        <bdi>{post.error}</bdi>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * The payoff. Until this exists, `SafetyPolicy`'s shipping defaults are guesses; after it,
 * they are derived from a number Facebook itself supplied.
 */
export function MeasuredDefaultsCard({ ceiling }: { ceiling: number }) {
  const { t } = useTranslation();
  const updateDraft = useStore((s) => s.updateDraft);
  const draft = useStore((s) => s.draft);
  const [applied, setApplied] = useState(false);
  const d = useMemo(() => measuredDefaults(ceiling), [ceiling]);

  function apply() {
    updateDraft({
      delay: { mode: "range", minSeconds: d.minSeconds, maxSeconds: d.maxSeconds },
      safetyBreak: { enabled: true, everyNPosts: d.breakEveryNPosts, durationSeconds: d.breakSeconds },
      antiDetection: { ...draft.antiDetection, dailyBudgetPerAccount: d.dailyBudgetPerAccount },
    });
    setApplied(true);
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-title-medium text-on-surface">{t("feasibility.measuredTitle")}</h2>
        <p className="mt-1 max-w-2xl text-body-medium text-on-surface-variant">
          {t("feasibility.measuredBody", { ceiling })}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label={t("feasibility.delay")} value={`${d.minSeconds}–${d.maxSeconds}s`} />
        <Figure label={t("feasibility.breakEvery")} value={String(d.breakEveryNPosts)} />
        <Figure label={t("feasibility.breakFor")} value={`${Math.round(d.breakSeconds / 60)}m`} />
        <Figure label={t("feasibility.dailyBudget")} value={String(d.dailyBudgetPerAccount)} />
      </dl>

      <Button icon={applied ? "check" : "tune"} variant="outlined" onClick={apply}>
        {applied ? t("feasibility.applied") : t("feasibility.applyDefaults")}
      </Button>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-container p-3">
      <dt className="text-label-medium text-on-surface-variant">{label}</dt>
      <dd className="mt-1 text-title-medium tabular-nums text-on-surface">
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * The report is the deliverable — a file that can be filed, attached to a decision, or
 * re-read in six months. Markdown for reading, JSON for anything that has to parse it.
 */
function downloadReport(record: FeasibilityRecord, format: "md" | "json"): void {
  const content = format === "json" ? JSON.stringify(record, null, 2) : toMarkdown(record);
  saveFile(content, `nashir-feasibility.${format}`, format);
}


function toMarkdown(record: FeasibilityRecord): string {
  const lines: string[] = ["# Nashir — feasibility check", ""];
  lines.push(`Generated: ${new Date(record.updatedAt).toISOString()}`);
  lines.push(`Gate passed: ${gatePassed(record) ? "YES" : "NO"}`, "");

  for (const id of ["post", "swap", "ramp"] as CheckId[]) {
    const check = record.checks[id];
    lines.push(`## ${id} — ${check.verdict}`, "");
    if (check.steps.length === 0) lines.push("_Not run._", "");
    for (const step of check.steps) {
      const evidence = step.evidence
        ? Object.entries(step.evidence)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      lines.push(`- **${step.id}** — ${step.status}${step.detail ? `: ${step.detail}` : ""} ${evidence}`.trim());
    }
    lines.push("");
  }

  if (record.ramp) {
    lines.push("## Rate ladder", "");
    lines.push(`Outcome: ${record.ramp.status}`);
    lines.push(`Ceiling: ${record.ramp.ceilingPostsPerHour ?? "none established"} posts/hour`, "");
    lines.push("| time | posts/hour | result |", "| --- | --- | --- |");
    for (const post of record.ramp.posts) {
      lines.push(
        `| ${new Date(post.at).toISOString()} | ${post.tierPostsPerHour} | ${post.throttled ? "THROTTLED" : post.status} |`,
      );
    }
  }

  return lines.join("\n");
}
