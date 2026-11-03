import type { GovernorSnapshot } from "@nashir/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { rpc } from "../lib/rpc.js";
import { Button, Card, Icon } from "../ui/index.js";

/** How often the shell asks whether a checkpoint is live. Our own service worker, not Facebook. */
const POLL_MS = 15_000;

type Phase = "idle" | "checking" | "still" | "noTab";

/**
 * Resolve a Facebook security check.
 *
 * "I've finished the check" verifies before it clears — it reads the Facebook page the
 * user already has open and only lifts the hold if the check is genuinely gone. A
 * button that cleared on trust would walk straight back into the block, and Facebook's
 * own guidance is that calls made during a block extend it.
 *
 * There is no "resume anyway" here, because a checkpoint cannot be waited out or forced
 * — but there IS an override, and it means something different. It overrides *our*
 * reading of Facebook, not Facebook. That distinction is load-bearing: this probe has
 * been wrong twice, and each time it left the extension locked with no way out at all.
 * A tool must never be able to permanently block its own user on the strength of its
 * own guess, so the override appears the moment a confirm fails.
 */
export function CheckpointActions({ onCleared }: { onCleared?: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  /** What the page probe actually said, so a wrong answer is diagnosable. */
  const [health, setHealth] = useState<string | null>(null);
  /** Shown only after a failed confirm — the way out when our own probe is wrong. */
  const [offerOverride, setOfferOverride] = useState(false);

  async function confirm() {
    setPhase("checking");
    const res = await rpc<{ cleared: boolean; health: string; needsTab: boolean }>({
      type: "RESOLVE_CHECKPOINT",
    });
    if (!res.ok || !res.data) return setPhase("idle");
    setHealth(res.data.health);
    if (res.data.cleared) {
      setPhase("idle");
      setOfferOverride(false);
      onCleared?.();
      return;
    }
    setPhase(res.data.needsTab ? "noTab" : "still");
    // A failed confirm is the moment the override becomes legitimate: either Facebook
    // is genuinely still asking, or our own probe is wrong — and the user is the only
    // one who can tell those apart.
    if (!res.data.needsTab) setOfferOverride(true);
  }

  async function override() {
    await rpc({ type: "CLEAR_COOLDOWN" });
    setPhase("idle");
    setOfferOverride(false);
    onCleared?.();
  }

  return (
    <>
      {phase === "still" && (
        <span className="text-label-medium text-error" role="status">
          {t("throttle.checkpointStill")}
          {health ? ` (${health})` : ""}
        </span>
      )}
      {phase === "noTab" && (
        <span className="text-label-medium text-on-surface-variant" role="status">
          {t("throttle.checkpointNoTab")}
        </span>
      )}
      <Button
        variant="text"
        icon="open_in_new"
        onClick={() => void chrome.tabs.create({ url: "https://www.facebook.com/" })}
      >
        {t("throttle.checkpointOpen")}
      </Button>
      <Button icon="check" disabled={phase === "checking"} onClick={() => void confirm()}>
        {phase === "checking" ? t("common.loading") : t("throttle.checkpointDone")}
      </Button>
      {/*
        The escape hatch. This does NOT override Facebook — it overrides *our* reading
        of Facebook, which has been wrong before and left the app locked with no way
        out. Offered only after a confirm has failed, so it is never the easy path.
      */}
      {offerOverride && (
        <Button variant="text" className="text-error" onClick={() => void override()}>
          {t("throttle.checkpointOverride")}
        </Button>
      )}
    </>
  );
}

/**
 * Shell-level banner for a live checkpoint.
 *
 * It lives in the app shell rather than on one page because the cooldown it reports is
 * the *governor's*, and the governor gates every Facebook call in the product — loading
 * groups, extracting an audience, posting. Putting the only way to clear it inside the
 * run bar meant it was unreachable unless a campaign happened to be running, which is
 * exactly the state a user is not in when their group list refuses to load.
 */
export function CheckpointBanner() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<GovernorSnapshot | null>(null);

  const refresh = async () => {
    const res = await rpc<GovernorSnapshot>({ type: "GET_GOVERNOR_SNAPSHOT" });
    if (res.ok && res.data) setSnap(res.data);
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  const cd = snap?.cooldown;
  if (!cd?.requiresOperator) return null;

  return (
    <Card variant="filled" className="mb-4 border border-error/40">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="warning" size={20} className="text-error" />
        <div className="min-w-0 flex-1">
          <b className="text-label-large text-on-surface">{t(`throttle.reason_${cd.reason}`)}</b>
          <p className="mt-0.5 text-body-small text-on-surface-variant">
            {t("throttle.checkpointBlocksAll")}
          </p>
          {/* Facebook's own words, so the operator is not guessing what was asked. */}
          {cd.evidence && (
            <p className="mt-1 text-body-small text-on-surface-variant" dir="auto">
              {cd.evidence.slice(0, 300)}
            </p>
          )}
        </div>
        <CheckpointActions onCleared={() => void refresh()} />
      </div>
    </Card>
  );
}
