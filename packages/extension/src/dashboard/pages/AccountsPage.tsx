import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CURRENT_SESSION, type Account, type AccountHealth } from "@nashir/shared";
import { rpc } from "../lib/rpc.js";
import { loadAccounts, loadSession } from "../lib/data.js";
import { useStore } from "../store.js";
import { Avatar } from "../components/Avatar.js";
import {
  Button,
  Card,
  Icon,
  IconButton,
  Snackbar,
  StatusChip,
  TextField,
  cn,
  type IconName,
  type StatusTone,
} from "../ui/index.js";

/** YYYY-MM-DD, the key CampaignEngine counts posts under. */
const todayKey = () => new Date().toISOString().slice(0, 10);

export function AccountsPage() {
  const { t } = useTranslation();
  const accounts = useStore((s) => s.accounts);
  const session = useStore((s) => s.session);
  const activeAccountId = useStore((s) => s.activeAccountId);
  const setActiveAccount = useStore((s) => s.setActiveAccount);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addCurrent() {
    setBusy("add");
    setError(null);
    const res = await rpc<Account>({ type: "ADD_ACCOUNT_FROM_SESSION" });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? t("accounts.addFailed"));
      return;
    }
    await loadAccounts();
    if (res.data) setActiveAccount(res.data.id);
  }

  async function act(id: string, work: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await loadAccounts();
    }
  }

  const alreadyAdded = accounts.some((a) => a.fbUserId === session?.profile?.fbUserId);

  return (
    <div className="space-y-4">
      {/* The live browser session is an account you can post from without adding
          anything, so it is shown as a first-class row rather than left implicit. */}
      <Card variant="filled" className="flex flex-wrap items-center gap-4">
        <Avatar src={session?.profile?.avatarUrl} name={session?.profile?.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <bdi className="truncate text-body-large text-on-surface">
              {session?.profile?.name ?? t("accounts.currentSession")}
            </bdi>
            <StatusChip tone={session?.loggedIn ? "success" : "error"}>
              {session?.loggedIn ? t("accounts.healthy") : t("accounts.loggedOut")}
            </StatusChip>
            {alreadyAdded && <StatusChip tone="neutral">{t("accounts.alreadyAdded")}</StatusChip>}
          </div>
          <p className="truncate text-body-small text-on-surface-variant" dir="ltr">
            {session?.profile?.fbUserId ?? t("accounts.currentSessionHint")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            icon="refresh"
            label={t("common.refresh")}
            onClick={() => void loadSession()}
          />
          <Button
            icon="add"
            disabled={busy !== null || !session?.loggedIn || alreadyAdded}
            onClick={() => void addCurrent()}
          >
            {busy === "add" ? t("accounts.adding") : t("accounts.addFromSession")}
          </Button>
        </div>
      </Card>

      {accounts.length === 0 ? (
        <Card variant="outlined">
          <p className="text-body-medium text-on-surface-variant">{t("accounts.empty")}</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id}>
              <AccountRow
                account={a}
                active={activeAccountId === a.id}
                busy={busy === a.id}
                onActivate={() => setActiveAccount(a.id)}
                onCheckHealth={() =>
                  void act(a.id, async () => {
                    await rpc({ type: "CHECK_ACCOUNT_HEALTH", accountId: a.id });
                  })
                }
                onRefreshProfile={() =>
                  void act(a.id, async () => {
                    const res = await rpc({ type: "REFRESH_ACCOUNT_PROFILE", accountId: a.id });
                    if (!res.ok) throw new Error(res.error ?? t("accounts.profileFailed"));
                  })
                }
                onRename={(label) =>
                  void act(a.id, async () => {
                    await rpc({ type: "SET_ACCOUNT_LABEL", accountId: a.id, label });
                  })
                }
                onRemove={() =>
                  void act(a.id, async () => {
                    await rpc({ type: "REMOVE_ACCOUNT", accountId: a.id });
                    if (activeAccountId === a.id) setActiveAccount(CURRENT_SESSION);
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}

      <Snackbar
        message={error}
        onDismiss={() => setError(null)}
        dismissLabel={t("common.dismiss")}
        actionLabel={t("common.retry")}
        onAction={() => void addCurrent()}
      />
    </div>
  );
}

function AccountRow({
  account,
  active,
  busy,
  onActivate,
  onCheckHealth,
  onRefreshProfile,
  onRename,
  onRemove,
}: {
  account: Account;
  active: boolean;
  busy: boolean;
  onActivate: () => void;
  onCheckHealth: () => void;
  onRefreshProfile: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(account.label);

  const postsToday = account.dailyCounts[todayKey()] ?? 0;
  const postsTotal = Object.values(account.dailyCounts).reduce((a, b) => a + b, 0);

  return (
    <Card
      variant={active ? "filled" : "outlined"}
      flush
      className={cn("p-2", active && "ring-1 ring-primary", busy && "opacity-60")}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onActivate}
          aria-pressed={active}
          className="state-layer flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-start"
        >
          <Avatar src={account.avatarUrl} name={account.label || account.name} size={44} />
          <span className="min-w-0">
            <bdi className="block truncate text-body-large text-on-surface">{account.label}</bdi>
            {/* The real Facebook name, kept visible when the user has renamed the account. */}
            {account.name && account.name !== account.label && (
              <bdi className="block truncate text-body-small text-on-surface-variant">
                {account.name}
              </bdi>
            )}
            <span className="block truncate text-body-small text-on-surface-variant" dir="ltr">
              {account.fbUserId}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <HealthChip health={account.health} />
          <IconButton icon="edit" label={t("accounts.rename")} onClick={() => setRenaming((v) => !v)} />
          <IconButton icon="person" label={t("accounts.refreshProfile")} onClick={onRefreshProfile} />
          <IconButton icon="refresh" label={t("accounts.check")} onClick={onCheckHealth} />
          <IconButton
            icon="delete"
            label={t("common.remove")}
            className="text-error"
            onClick={onRemove}
          />
        </div>
      </div>

      {renaming && (
        <form
          className="flex items-end gap-2 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = draftLabel.trim();
            if (next && next !== account.label) onRename(next);
            setRenaming(false);
          }}
        >
          <TextField
            label={t("accounts.rename")}
            className="flex-1"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            autoFocus
          />
          <Button type="submit" className="mb-1">
            {t("common.save")}
          </Button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-outline-variant px-2 pb-1 pt-2 text-body-small text-on-surface-variant">
        <Fact icon="bolt" label={t("accounts.postsToday")} value={String(postsToday)} />
        <Fact icon="check_circle" label={t("accounts.postsTotal")} value={String(postsTotal)} />
        <Fact icon="schedule" label={t("accounts.added")} value={formatDate(account.addedAt)} />
        {account.lastActiveAt && (
          <Fact icon="play_arrow" label={t("accounts.lastActive")} value={formatDate(account.lastActiveAt)} />
        )}
        {account.profileUrl && (
          <a
            href={account.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline"
          >
            <Icon name="open_in_new" size={14} />
            {t("accounts.openProfile")}
          </a>
        )}
      </div>
    </Card>
  );
}

function Fact({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon name={icon} size={14} />
      <span>{label}</span>
      <span className="font-medium text-on-surface" dir="auto">
        {value}
      </span>
    </span>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function HealthChip({ health }: { health: AccountHealth }) {
  const { t } = useTranslation();

  const tone: Record<AccountHealth, StatusTone> = {
    ok: "success",
    logged_out: "neutral",
    checkpoint: "error",
    unknown: "neutral",
  };
  const label: Record<AccountHealth, string> = {
    ok: t("accounts.healthy"),
    logged_out: t("accounts.loggedOut"),
    checkpoint: t("accounts.checkpoint"),
    unknown: "—",
  };

  return <StatusChip tone={tone[health]}>{label[health]}</StatusChip>;
}
