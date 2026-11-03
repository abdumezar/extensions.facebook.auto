import { useTranslation } from "react-i18next";
import type { RunSnapshot } from "@nashir/shared";
import { formatDuration } from "../lib/format.js";
import { StatusChip } from "../ui/index.js";

/**
 * What the operator is shown while Facebook is blocking us.
 *
 * Split out of `RunBar` so it can be asserted directly: this is the one place the app
 * has to be honest about a bad situation, and "nothing is wrong, we are waiting, your
 * queue is intact" is easy to render as something that reads like a failure.
 */

/**
 * Which action the bar may offer.
 *
 * `force` is deliberately not the same as `resume`. Resuming into a live block is the
 * documented way to make the block last longer, so it has to be a different button
 * with a confirmation behind it — never the obvious one.
 */
export type CooldownAction = "resume" | "force" | "checkpoint" | "none";

export function cooldownAction(snap: RunSnapshot, now: number): CooldownAction {
  if (snap.status !== "cooldown") return "none";
  // A checkpoint has no clock. No amount of waiting clears it and no override is
  // honest, so it gets neither `resume` nor `force` — but it does need an action, and
  // returning "none" here left the extension locked with no way out at all once
  // Facebook asked for a security check.
  if (snap.requiresOperator) return "checkpoint";
  return (snap.cooldownUntil ?? 0) <= now ? "resume" : "force";
}

export function CooldownNotice({ snap, now }: { snap: RunSnapshot; now: number }) {
  const { t } = useTranslation();
  const msLeft = Math.max(0, (snap.cooldownUntil ?? 0) - now);
  const remaining = Math.max(0, snap.total - snap.done);

  return (
    <>
      <StatusChip tone="warning" icon="warning">
        {t(`throttle.reason_${snap.cooldownClass ?? "rate_limit"}`)}
      </StatusChip>
      <span>{t("throttle.heldForYou", { remaining })}</span>
      {snap.requiresOperator ? (
        <span>{t("throttle.checkpointAction")}</span>
      ) : msLeft > 0 ? (
        <span>{t("throttle.resumesIn", { time: formatDuration(msLeft) })}</span>
      ) : (
        <span>{t("throttle.readyToResume")}</span>
      )}
    </>
  );
}
