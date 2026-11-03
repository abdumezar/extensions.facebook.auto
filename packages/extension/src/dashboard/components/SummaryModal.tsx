import { useTranslation } from "react-i18next";
import type { RunSnapshot, PostResult } from "@nashir/shared";
import { Button, Dialog, Icon, LinearProgress } from "../ui/index.js";

export function SummaryModal({
  snap,
  results,
  onClose,
}: {
  snap: RunSnapshot;
  results: PostResult[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rate = snap.total > 0 ? Math.round((snap.published / snap.total) * 100) : 0;
  const links = results.filter((r) => r.permalink).slice(0, 15);

  return (
    <Dialog
      open
      onClose={onClose}
      headline={t("summary.title")}
      actions={<Button onClick={onClose}>{t("summary.close")}</Button>}
    >
      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label={t("summary.total")} value={snap.total} tone="text-on-surface" />
        <Stat label={t("run.published")} value={snap.published} tone="text-success" />
        <Stat label={t("run.pending")} value={snap.pending} tone="text-warning" />
        <Stat label={t("run.failed")} value={snap.failed} tone="text-error" />
      </div>

      <div className="mt-6">
        <div className="mb-2 flex justify-between text-body-small">
          <span>{t("summary.successRate")}</span>
          <span>{rate}%</span>
        </div>
        <LinearProgress value={rate} label={t("summary.successRate")} />
      </div>

      {links.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-title-small text-on-surface">{t("summary.links")}</div>
          <div className="max-h-52 space-y-1 overflow-y-auto" dir="ltr">
            {links.map((r, i) => (
              <a
                key={i}
                href={r.permalink}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate text-body-small text-primary underline"
              >
                <Icon name="open_in_new" size={14} />
                <span className="truncate">{r.permalink}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md bg-surface-container-highest py-3">
      <div className={`text-headline-small ${tone}`}>{value}</div>
      <div className="text-label-small text-on-surface-variant">{label}</div>
    </div>
  );
}
