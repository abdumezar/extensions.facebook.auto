import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Group, GroupLeavePreview, GroupLeaveResult } from "@nashir/shared";
import { leaveGroups, previewLeaveGroup } from "../lib/data.js";
import { Button, Dialog, Icon } from "../ui/index.js";

export interface LeaveGroupsDialogProps {
  /** Which account is leaving — a managed account id, or CURRENT_SESSION. */
  accountId: string;
  /** Groups to leave. Exactly one gets Facebook's own warning copy fetched first. */
  targets: Group[];
  onClose: () => void;
  /** Called once the batch finishes, with a per-group outcome. */
  onDone: (results: GroupLeaveResult[]) => void;
}

/**
 * Confirmation for leaving groups — the one gate in front of an irreversible write.
 *
 * Leaving a group you are the last member of DELETES it for everyone, and Facebook's
 * API cannot be asked which case this is in advance. So for a single group we first
 * fetch Facebook's own leave dialog and show whatever it warns about; for a batch we
 * state the rule plainly, since previewing every group would be one request each.
 *
 * The confirm button stays disabled until that check resolves: confirming a delete the
 * user was never shown is the failure mode this whole component exists to prevent.
 */
export function LeaveGroupsDialog({ accountId, targets, onClose, onDone }: LeaveGroupsDialogProps) {
  const { t } = useTranslation();
  const single = targets.length === 1 ? targets[0] : null;

  const [preview, setPreview] = useState<GroupLeavePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!single) return;
    let live = true;
    setChecking(true);
    setError(null);
    previewLeaveGroup(accountId, single.id)
      .then((p) => live && setPreview(p))
      // A failed check must not block the action — it is extra warning copy, not consent.
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [accountId, single]);

  async function confirm() {
    setLeaving(true);
    setError(null);
    try {
      onDone(await leaveGroups(accountId, targets.map((g) => g.id)));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLeaving(false);
    }
  }

  const headline = single
    ? (preview?.confirmationTitle ?? t("leave.title"))
    : t("leave.titleMany", { n: targets.length });

  return (
    <Dialog
      open
      onClose={leaving ? () => {} : onClose}
      headline={headline}
      icon="logout"
      actions={
        <>
          <Button variant="text" onClick={onClose} disabled={leaving}>
            {t("common.cancel")}
          </Button>
          <Button variant="filled" icon="logout" onClick={() => void confirm()} disabled={leaving || checking}>
            {leaving
              ? t("leave.leaving")
              : single
                ? (preview?.leaveLabel ?? t("leave.confirm"))
                : t("leave.confirmMany", { n: targets.length })}
          </Button>
        </>
      }
    >
      <p>
        {single
          ? t("leave.body", { name: single.name })
          : t("leave.bodyMany", { n: targets.length })}
      </p>

      {!single && (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-body-small">
          {targets.map((g) => (
            <li key={g.id}>
              <bdi>{g.name}</bdi>
            </li>
          ))}
        </ul>
      )}

      {checking && (
        <p className="mt-3 flex items-center gap-2 text-body-small" aria-live="polite">
          <Icon name="hourglass_empty" size={16} />
          {t("leave.checking")}
        </p>
      )}

      {/* Facebook offering an outright delete is the strongest signal we get. */}
      {preview?.canDelete && <Warning tone="error">{t("leave.deleteWarning")}</Warning>}
      {preview?.deletesGroupWhenLastMemberLeaves && !preview.canDelete && (
        <Warning tone="warning">{t("leave.lastMemberNote")}</Warning>
      )}
      {!single && <Warning tone="warning">{t("leave.manyWarning")}</Warning>}

      {error && <Warning tone="error">{error}</Warning>}
    </Dialog>
  );
}

/** An inline callout inside the dialog body, coloured by how bad the news is. */
function Warning({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  const isError = tone === "error";
  return (
    <p
      className={
        isError
          ? "mt-3 flex gap-2 rounded-sm bg-error-container p-3 text-body-small text-on-error-container"
          : "mt-3 flex gap-2 rounded-sm bg-tertiary-container p-3 text-body-small text-on-tertiary-container"
      }
    >
      <Icon name={isError ? "error" : "warning"} size={18} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
