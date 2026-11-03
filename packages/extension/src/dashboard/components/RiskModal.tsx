import { useTranslation } from "react-i18next";
import type { DelayRecommendation, DelayConfig } from "@nashir/shared";
import { formatDuration } from "../lib/format.js";
import { Button, Dialog } from "../ui/index.js";

/**
 * Blocking warning shown when the chosen delay is too aggressive for the group count.
 * Shows the risky setting, the safe recommendation, and two choices — apply the safe
 * delay, or post anyway.
 */
export function RiskModal({
  delay,
  recommendation,
  onApplySafe,
  onPostAnyway,
  onCancel,
}: {
  delay: DelayConfig;
  recommendation: DelayRecommendation;
  onApplySafe: () => void;
  onPostAnyway: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const fmtRange = (minS: number, maxS: number) =>
    minS === maxS ? formatDuration(minS * 1000) : `${formatDuration(minS * 1000)} – ${formatDuration(maxS * 1000)}`;

  return (
    <Dialog
      open
      onClose={onCancel}
      icon="warning"
      headline={t("risk.title")}
      actions={
        <>
          <Button variant="text" className="text-error" onClick={onPostAnyway}>
            {t("risk.postAnyway")}
          </Button>
          <Button onClick={onApplySafe}>{t("risk.applySafe")}</Button>
        </>
      }
    >
      <p>{t("risk.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-md bg-error-container p-3 text-on-error-container">
          <div className="text-label-small opacity-80">{t("risk.yourSetting")}</div>
          <div className="text-title-small">{fmtRange(delay.minSeconds, delay.maxSeconds)}</div>
        </div>
        <div className="rounded-md bg-success-container p-3 text-on-success-container">
          <div className="text-label-small opacity-80">{t("risk.recommended")}</div>
          <div className="text-title-small">
            {fmtRange(recommendation.minSeconds, recommendation.maxSeconds)}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
