import { useTranslation } from "react-i18next";
import type { GovernorSnapshot } from "@nashir/shared";
import { formatDuration } from "../lib/format.js";
import { Card, Icon, StatusChip } from "../ui/index.js";

/**
 * What the app has spent on Facebook in the last hour, and whether it is blocked.
 *
 * Before this existed, a call timeline could not be reconstructed from the logs at
 * all — the incident that prompted the whole call governor had to be diagnosed by
 * reading the source rather than by reading what the app recorded. The point of this
 * card is that the next one does not.
 */
export function GovernorCard({ snap, now }: { snap: GovernorSnapshot; now: number }) {
  const { t } = useTranslation();
  const cd = snap.cooldown;
  const msLeft = cd ? Math.max(0, cd.untilMs - now) : 0;
  const classes = Object.entries(snap.byClass).sort((a, b) => b[1] - a[1]);

  return (
    <Card variant="filled" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="speed" size={18} />
        <b className="text-label-large">{t("governor.title")}</b>
        <StatusChip tone={cd ? "warning" : "success"} icon={cd ? "warning" : "check_circle"}>
          {cd ? t(`throttle.reason_${cd.reason}`) : t("governor.clear")}
        </StatusChip>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-body-medium">
        <span>
          {t("governor.lastHour")}: <b>{snap.callsLastHour}</b>
        </span>
        <span>
          {t("governor.lastMinute")}: <b>{snap.callsLastMinute}</b>
        </span>
      </div>

      {cd && (
        <div className="space-y-1 rounded-lg bg-warning-container p-3 text-body-small text-on-warning-container">
          <div>
            {cd.requiresOperator
              ? t("throttle.checkpointAction")
              : t("throttle.resumesIn", { time: formatDuration(msLeft) })}
          </div>
          {/* Facebook's own sentence, verbatim. A paraphrase is exactly what stops the
              next person recognising the same block. */}
          {cd.evidence && (
            <div>
              {t("throttle.saidByFacebook")}: <bdi>{cd.evidence}</bdi>
            </div>
          )}
          <div className="opacity-70">
            {t("governor.matched")}: <code>{cd.matchedSignal || "—"}</code>
          </div>
        </div>
      )}

      {classes.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body-small text-on-surface-variant">
          {classes.map(([cls, n]) => (
            <li key={cls}>
              <code>{cls}</code> {n}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
