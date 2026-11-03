import type { BusyReason, UpdateState } from "@nashir/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { linkFolder, runSelfUpdate, type SelfUpdateError } from "../lib/selfUpdate.js";
import { Button } from "../ui/index.js";

type Problem = SelfUpdateError | "wrong_folder" | "link_failed";

/** The i18n key that says what went wrong, in the user's words. */
function problemKey(problem: Problem, reason?: BusyReason): string {
  if (problem === "busy" && reason) return `update.busy_${reason}`;
  if (problem === "wrong_folder") return "update.link_wrong_folder";
  if (problem === "link_failed") return "update.link_failed";
  return `update.error_${problem}`;
}

/** Problems that the folder picker can fix. */
const FOLDER_PROBLEMS: ReadonlySet<Problem> = new Set(["not_linked", "wrong_folder", "link_failed"]);

/**
 * The "Update now" button and everything that can come back from pressing it. Shared by
 * the banner and the Settings section, so both answer a refusal the same way.
 *
 * With no folder linked, the way forward is offered right here: choosing the folder is a
 * click that carries on with the update, so the person is not sent off to another page
 * and back.
 */
export function UpdateActions({ state }: { state: UpdateState }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "working" | "reloading">("idle");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busyReason, setBusyReason] = useState<BusyReason | undefined>();

  async function update() {
    setPhase("working");
    setProblem(null);
    setBusyReason(undefined);
    const result = await runSelfUpdate(state);
    if (result === "reloading") return setPhase("reloading");
    setPhase("idle");
    setProblem(result.error);
    setBusyReason(result.reason);
  }

  async function choose() {
    const linked = await linkFolder();
    if (linked === "linked") return update();
    if (linked === "wrong_folder") setProblem("wrong_folder");
    else if (linked === "failed") setProblem("link_failed");
    // Closing the picker is not an error; the earlier message stays.
  }

  if (phase === "reloading") {
    return (
      <p role="status" className="text-body-medium text-on-surface">
        {t("update.reloading")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {problem && (
        <p role="status" className="text-body-small text-error">
          {t(problemKey(problem, busyReason))}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button icon="download" disabled={phase === "working"} onClick={() => void update()}>
          {phase === "working" ? t("update.updating") : t("update.updateNow")}
        </Button>
        {problem && FOLDER_PROBLEMS.has(problem) && (
          <Button variant="tonal" disabled={phase === "working"} onClick={() => void choose()}>
            {t("update.chooseFolder")}
          </Button>
        )}
      </div>
    </div>
  );
}
