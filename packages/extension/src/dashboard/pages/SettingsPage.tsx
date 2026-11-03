import { useTranslation } from "react-i18next";
import { UpdatesSection } from "../components/UpdatesSection.js";
import { useStore } from "../store.js";
import { Button, Card } from "../ui/index.js";

export function SettingsPage() {
  const { t } = useTranslation();
  const setView = useStore((s) => s.setView);

  return (
    <div className="max-w-2xl space-y-4">
      <UpdatesSection />

      {/*
        The only door into the feasibility gate. It stays out of the sidebar because it
        posts to real groups — an operator tool, not something to wander into.
      */}
      <Card>
        <div className="mb-1 text-title-medium text-on-surface">{t("settings.diagnostics")}</div>
        <p className="mb-3 text-body-medium text-on-surface-variant">
          {t("settings.diagnosticsDesc")}
        </p>
        <Button variant="outlined" icon="science" onClick={() => setView("feasibility")}>
          {t("settings.openDiagnostics")}
        </Button>
      </Card>

      <Card>
        <div className="mb-1 text-title-medium text-on-surface">{t("settings.about")}</div>
        <p className="text-body-medium text-on-surface-variant">
          {t("app.name")} · {t("app.tagline")}
          <br />© {new Date().getFullYear()} Nashir.
        </p>
      </Card>
    </div>
  );
}
