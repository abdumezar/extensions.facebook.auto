import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CURRENT_SESSION, type RunStatus } from "@nashir/shared";
import { useStore, resolveGroupIds, type ViewId } from "../store.js";
import { fetchSession, loadSession, reloadGroups } from "../lib/data.js";
import { SESSION_PROFILE_KEY } from "../../engine/SessionProbe.js";
import { VERIFIED_KEY } from "../../engine/verification.js";
import { Avatar } from "../components/Avatar.js";
import { Button, Card, Icon, StatusChip, cn, type IconName, type StatusTone } from "../ui/index.js";

/**
 * Home. Restructured around the question a user actually arrives with — "can I press
 * start yet, and if not, what is missing?" — rather than a wall of counters.
 *
 * Top to bottom: the Facebook connection (everything else depends on it), a readiness
 * checklist that doubles as navigation, then the numbers.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const setView = useStore((s) => s.setView);
  const session = useStore((s) => s.session);
  const accounts = useStore((s) => s.accounts);
  const groups = useStore((s) => s.groups);
  const selected = useStore((s) => s.selectedGroupIds);
  const manual = useStore((s) => s.draft.manualGroupIds);
  const variations = useStore((s) => s.draft.variations);
  const mediaCount = useStore((s) => s.draft.media.length);
  const snapshot = useStore((s) => s.snapshot);

  const targetCount = useMemo(() => resolveGroupIds(selected, manual).length, [selected, manual]);
  const written = variations.filter((v) => v.trim().length > 0).length;

  const steps: Step[] = [
    {
      id: "session",
      done: Boolean(session?.loggedIn),
      view: "accounts",
      detail: session?.loggedIn
        ? t("home.stepSessionDone", { name: session.profile?.name ?? session.profile?.fbUserId ?? "" })
        : t("home.stepSessionDetail"),
    },
    {
      id: "content",
      done: written > 0,
      view: "content",
      detail: written
        ? t("home.stepContentDone", { n: written, media: mediaCount })
        : t("home.stepContentDetail"),
    },
    {
      id: "groups",
      done: targetCount > 0,
      view: "groups",
      detail: targetCount ? t("home.stepGroupsDone", { n: targetCount }) : t("home.stepGroupsDetail"),
    },
  ];

  return (
    <div className="space-y-6">
      <ConnectionCard />

      <Checklist steps={steps} onGo={setView} />

      <section aria-labelledby="home-stats">
        <h2 id="home-stats" className="sr-only">
          {t("home.stats")}
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label={t("dashboard.totalGroups")} value={groups.length} icon="groups" />
          <Stat label={t("dashboard.selected")} value={targetCount} icon="check" />
          <Stat label={t("dashboard.accounts")} value={accounts.length} icon="person" />
          <Stat label={t("dashboard.status")} value={runLabel(snapshot?.status, t)} icon="schedule" />
        </div>
      </section>
    </div>
  );
}

/**
 * The Facebook connection, stated plainly. This is the one card whose absence explains
 * every other failure in the app, so it leads — and it says what to do about it.
 */
function ConnectionCard() {
  const { t } = useTranslation();
  const session = useStore((s) => s.session);
  const activeAccountId = useStore((s) => s.activeAccountId);
  const groups = useStore((s) => s.groups);
  const syncedAt = useStore((s) => s.groupsSyncedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [, setTick] = useState(0);

  const connected = Boolean(session?.loggedIn);
  // A live check made in the last few hours counts even if the page that made it is
  // closed — the service worker only reports `verifiedAt` while the same login holds.
  const verifiedAt = connected ? session?.verifiedAt : undefined;
  const verified = connected && (Boolean(session?.tokensReady) || verifiedAt !== undefined);
  const tone: StatusTone = connected ? (verified ? "success" : "warning") : "error";
  const label = !connected
    ? t("home.disconnected")
    : verified
      ? t("home.connected")
      : t("home.connectedUnverified");

  // "4 min ago" goes stale on its own, so the page re-renders once a minute.
  useEffect(() => {
    if (verifiedAt === undefined) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [verifiedAt]);

  // A verification or a remembered profile can land while this page is open (a
  // Facebook tab was opened, a scrape ran). Follow the keys rather than reading once,
  // unless the session already has live tokens — then there is nothing to learn.
  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes[VERIFIED_KEY] && !changes[SESSION_PROFILE_KEY]) return;
      if (useStore.getState().session?.tokensReady === true) return;
      const mine = ++latest;
      void fetchSession().then((next) => {
        // A failed read keeps what is already shown; a reply that was overtaken by a
        // newer read, or that arrives after unmount, is dropped.
        if (cancelled || mine !== latest || !next) return;
        useStore.getState().setSession(next);
      });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  async function sync() {
    setBusy(true);
    setError(null);
    try {
      await reloadGroups(activeAccountId);
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card variant="filled" className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar src={session?.profile?.avatarUrl} name={session?.profile?.name} size={48} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <bdi className="truncate text-title-medium text-on-surface">
              {session?.profile?.name ?? t("home.unknownUser")}
            </bdi>
            <StatusChip tone={tone}>{label}</StatusChip>
          </div>
          <p className="mt-0.5 text-body-small text-on-surface-variant" dir={connected ? "ltr" : undefined}>
            {connected ? (session?.profile?.fbUserId ?? "") : t("home.disconnectedHint")}
          </p>
          {verifiedAt !== undefined && !session?.tokensReady && (
            <p className="mt-0.5 text-body-small text-on-surface-variant">
              {t("home.verifiedAgo", { ago: relativeTime(verifiedAt, t) })}
            </p>
          )}
          {/*
            The name above may be one we remembered rather than one we just read. The
            warning chip already says the session is unverified, but it does not say
            that the *identity* is from memory — and a card naming an account you have
            since logged out of is worth one line to prevent.
          */}
          {connected && !verified && session?.profileFresh === false && session.profile?.name && (
            <p className="mt-0.5 text-body-small text-on-surface-variant">
              {t("home.profileRemembered")}
            </p>
          )}
        </div>

        {connected ? (
          <Button variant="tonal" icon="sync" disabled={busy} onClick={() => void sync()}>
            {busy ? t("groups.loading") : t("home.syncGroups")}
          </Button>
        ) : (
          <Button
            icon="open_in_new"
            onClick={() => void chrome.tabs.create({ url: "https://www.facebook.com/" })}
          >
            {t("home.openFacebook")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-outline-variant pt-3 text-body-small text-on-surface-variant">
        <span className="flex items-center gap-1.5">
          <Icon name="groups" size={16} />
          {t("home.groupsCached", { n: groups.length })}
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="schedule" size={16} />
          {syncedAt > 0 ? t("home.syncedAgo", { ago: relativeTime(syncedAt, t) }) : t("home.neverSynced")}
        </span>
        {activeAccountId !== CURRENT_SESSION && (
          <StatusChip tone="neutral">{t("home.managedAccount")}</StatusChip>
        )}
      </div>

      {error && (
        <p role="alert" className="text-body-small text-error" dir="ltr">
          {error}
        </p>
      )}
    </Card>
  );
}

interface Step {
  id: "session" | "content" | "groups";
  done: boolean;
  view: ViewId;
  detail: string;
}

/** Readiness as a checklist: what is done, what is left, and one click to go fix it. */
function Checklist({ steps, onGo }: { steps: Step[]; onGo: (v: ViewId) => void }) {
  const { t } = useTranslation();
  const remaining = steps.filter((s) => !s.done).length;

  return (
    <section aria-labelledby="home-checklist" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="home-checklist" className="text-title-medium text-on-surface">
          {t("home.checklist")}
        </h2>
        <StatusChip tone={remaining === 0 ? "success" : "warning"}>
          {remaining === 0 ? t("home.ready") : t("home.stepsLeft", { n: remaining })}
        </StatusChip>
      </div>

      <ol className="grid gap-3 sm:grid-cols-3">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => onGo(step.view)}
              className={cn(
                "state-layer flex h-full w-full items-start gap-3 rounded-md border p-4 text-start",
                "transition-colors duration-short2 ease-standard",
                step.done ? "border-success bg-success-container/40" : "border-outline-variant bg-surface",
              )}
            >
              <Icon
                name={step.done ? "check_circle" : "radio_button_unchecked"}
                size={22}
                className={cn("mt-0.5", step.done ? "text-success" : "text-on-surface-variant")}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-title-small text-on-surface">{t(`home.step_${step.id}`)}</span>
                <span className="mt-0.5 block text-body-small text-on-surface-variant">{step.detail}</span>
              </span>
              <Icon
                name="arrow_forward"
                size={18}
                className="mt-1 shrink-0 text-on-surface-variant rtl:rotate-180"
              />
            </button>
          </li>
        ))}
      </ol>
    </section>
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

function runLabel(status: RunStatus | undefined, t: (k: string) => string): string {
  switch (status) {
    case "running":
      return t("run.running");
    case "paused":
      return t("run.paused");
    case "safety_break":
      return t("run.break");
    case "cooldown":
      return t("run.cooldown");
    default:
      return t("dashboard.idle");
  }
}

/** Coarse "how long ago" — precision below a minute would only add churn to the page. */
function relativeTime(at: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return t("home.justNow");
  if (mins < 60) return t("home.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("home.hoursAgo", { count: hours });
  return t("home.daysAgo", { count: Math.round(hours / 24) });
}
