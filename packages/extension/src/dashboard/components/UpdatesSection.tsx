import type { UpdateError, UpdateState } from "@nashir/shared";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { appVersion } from "../appVersion.js";
import { formatTimestamp } from "../lib/format.js";
import { rpc } from "../lib/rpc.js";
import { folderLinked, linkFolder } from "../lib/selfUpdate.js";
import { Button, Card, Icon, StatusChip } from "../ui/index.js";
import { UpdateActions } from "./UpdateActions.js";

type LinkProblem = "wrong_folder" | "failed";

/** How long "Checked just now" stays before the real time is shown again. */
const JUST_CHECKED_MS = 60_000;
/** Always right, whatever the check said: the newest release and its notes. */
const RELEASES_PAGE = "https://github.com/abdumezar/extensions.facebook.auto/releases/latest";

/**
 * Settings: the version, the folder updates are written into, "check now", and the
 * manual route (download the zip, unzip it over the folder, reload) for when the
 * one-click route cannot be used.
 */
export function UpdatesSection() {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [state, setState] = useState<UpdateState | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [linkProblem, setLinkProblem] = useState<LinkProblem | null>(null);
  const [checking, setChecking] = useState(false);
  // A check inside the throttle window answers from the stored result, which looks
  // exactly like "nothing happened". The person pressed the button, so say it was done.
  const [justChecked, setJustChecked] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void rpc<UpdateState>({ type: "GET_UPDATE_STATE" }).then((res) => {
      if (live && res.ok && res.data) setState(res.data);
    });
    void folderLinked().then((value) => {
      if (live) setLinked(value);
    });
    return () => {
      live = false;
    };
  }, []);

  // "Just now" is only true for a little while.
  useEffect(() => {
    if (!justChecked) return;
    const id = window.setTimeout(() => setJustChecked(false), JUST_CHECKED_MS);
    return () => window.clearTimeout(id);
  }, [justChecked]);

  async function checkNow() {
    setChecking(true);
    setCheckFailed(false);
    const res = await rpc<UpdateState>({ type: "CHECK_FOR_UPDATE" });
    setChecking(false);
    if (res.ok && res.data) {
      setState(res.data);
      setJustChecked(true);
    } else {
      setCheckFailed(true);
    }
  }

  async function link() {
    setLinkProblem(null);
    const result = await linkFolder();
    if (result === "linked") setLinked(true);
    else if (result === "wrong_folder" || result === "failed") setLinkProblem(result);
  }

  const reason = (error: UpdateError) => t(`update.reason_${error}`);
  const offer = state?.status === "available" && state.latest ? state.latest : null;

  return (
    <Card aria-labelledby={titleId} className="space-y-4">
      <div className="flex items-center gap-3">
        <Icon name="sync" size={18} />
        <h2 id={titleId} className="text-title-medium text-on-surface">
          {t("update.sectionTitle")}
        </h2>
      </div>

      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-body-medium">
        <dt className="text-on-surface-variant">{t("update.installed")}</dt>
        <dd dir="ltr" className="justify-self-start tabular-nums">
          {appVersion()}
        </dd>

        <dt className="text-on-surface-variant">{t("update.folder")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {linked !== null && (
            <StatusChip tone={linked ? "success" : "neutral"} icon={linked ? "check_circle" : undefined}>
              {linked ? t("update.folderLinked") : t("update.folderNotLinked")}
            </StatusChip>
          )}
          <Button variant="outlined" onClick={() => void link()}>
            {linked ? t("update.relinkFolder") : t("update.linkFolder")}
          </Button>
        </dd>
      </dl>
      <p className="text-body-small text-on-surface-variant">{t("update.folderHelp")}</p>
      {linkProblem && (
        <p role="status" className="text-body-small text-error">
          {t(linkProblem === "wrong_folder" ? "update.link_wrong_folder" : "update.link_failed")}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="tonal" icon="refresh" disabled={checking} onClick={() => void checkNow()}>
            {checking ? t("update.checking") : t("update.checkNow")}
          </Button>
          {state && (
            <span className="text-body-small text-on-surface-variant" role="status">
              {justChecked
                ? t("update.checkedJustNow")
                : state.checkedAt != null
                  ? t("update.lastChecked", { when: formatTimestamp(state.checkedAt, i18n.language) })
                  : t("update.neverChecked")}
            </span>
          )}
        </div>
        {checkFailed && (
          <p role="status" className="text-body-small text-error">
            {t("update.checkFailedToRun")}
          </p>
        )}

        {state?.status === "error" && state.error && (
          <p className="text-body-small text-on-surface-variant">
            {t("update.checkError", { reason: reason(state.error) })}
          </p>
        )}
        {state?.lastCheckFailed && (
          <p className="text-body-small text-on-surface-variant">
            {t("update.lastCheckFailed", { reason: reason(state.lastCheckFailed.error) })}
          </p>
        )}
        {/* Only once a check has actually answered: the stored result is dropped by an update. */}
        {state?.status === "idle" && state.checkedAt != null && (
          <p className="text-body-medium text-on-surface">{t("update.upToDate")}</p>
        )}
      </div>

      {state && offer && (
        <div className="space-y-3">
          <p className="text-body-medium text-on-surface">{t("update.available", { version: offer.version })}</p>
          <UpdateActions state={state} />
        </div>
      )}

      <div className="space-y-2 border-t border-outline-variant pt-3">
        <div className="text-label-large text-on-surface">{t("update.manualTitle")}</div>
        <ol className="list-decimal space-y-1 ps-5 text-body-small text-on-surface-variant">
          <li>{t("update.manual1")}</li>
          <li>{t("update.manual2")}</li>
          <li>{t("update.manual3")}</li>
        </ol>
        <div className="flex flex-wrap items-center gap-4">
          {offer && (
            <a
              href={offer.zipUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-label-large text-primary underline"
            >
              {t("update.downloadZip")}
            </a>
          )}
          <a
            href={RELEASES_PAGE}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-label-large text-primary underline"
          >
            {t("update.openReleases")}
          </a>
        </div>
      </div>
    </Card>
  );
}
