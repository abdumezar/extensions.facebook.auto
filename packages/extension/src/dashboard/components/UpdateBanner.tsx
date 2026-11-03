import type { UpdateState } from "@nashir/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UPDATE_STORAGE_KEY } from "../../update/UpdateService.js";
import { appVersion } from "../appVersion.js";
import { rpc } from "../lib/rpc.js";
import { Button, Card, Icon } from "../ui/index.js";
import { UpdateActions } from "./UpdateActions.js";

/** The version the service worker passed in when it opened this page after an update. */
function readUpdatedFrom(): string | null {
  const from = new URLSearchParams(window.location.search).get("updatedFrom");
  return from && from !== appVersion() ? from : null;
}

/**
 * Shell-level notice about updates: "version X is available" with the button that
 * installs it, and, on the first page after an update, "updated to X".
 *
 * It is in the shell, not on Settings, because an update is only useful to someone who
 * does not go looking for one.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState | null>(null);
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(readUpdatedFrom);
  const [hidden, setHidden] = useState(false);

  // Read on open, and again whenever the service worker stores a new result (its own
  // timer finding a release while this page is open). Only the newest read may apply.
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      void rpc<UpdateState>({ type: "GET_UPDATE_STATE" }).then((res) => {
        if (live && mine === latest && res.ok && res.data) setState(res.data);
      });
    };
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && UPDATE_STORAGE_KEY in changes) load();
    };
    load();
    const events = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
    events?.addListener(onChanged);
    return () => {
      live = false;
      events?.removeListener(onChanged);
    };
  }, []);

  // Said once: a reload of this page must not announce the same update again.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("updatedFrom")) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("updatedFrom");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const offer = state?.status === "available" && state.latest ? state.latest : null;

  if (updatedFrom) {
    return (
      <Card variant="filled" className="mb-4 border border-primary/40">
        <div className="flex flex-wrap items-center gap-3">
          <Icon name="check_circle" size={20} className="text-primary" />
          <div className="min-w-0 flex-1">
            <b className="text-label-large text-on-surface">{t("update.updatedTo", { version: appVersion() })}</b>
            <p className="mt-0.5 text-body-small text-on-surface-variant">
              <bdi>{t("update.updatedFrom", { from: updatedFrom })}</bdi>
            </p>
          </div>
          <Button variant="text" onClick={() => setUpdatedFrom(null)}>
            {t("common.dismiss")}
          </Button>
        </div>
      </Card>
    );
  }

  if (!state || !offer || hidden) return null;

  return (
    <Card variant="filled" className="mb-4 border border-primary/40">
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="download" size={20} className="mt-0.5 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <b className="text-label-large text-on-surface">{t("update.bannerTitle", { version: offer.version })}</b>
            <p className="mt-0.5 text-body-small text-on-surface-variant">
              {t("update.bannerBody", { current: state.current })}
            </p>
            <a
              href={offer.notesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-label-medium text-primary underline"
            >
              {t("update.whatsNew")}
            </a>
          </div>
          <UpdateActions state={state} />
        </div>
        <Button variant="text" onClick={() => setHidden(true)}>
          {t("common.dismiss")}
        </Button>
      </div>
    </Card>
  );
}
