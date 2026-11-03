import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore, type ViewId } from "./store.js";
import { bootstrapSession, loadAccounts, primeGroups } from "./lib/data.js";
import { Sidebar } from "./components/Sidebar.js";
import { Topbar } from "./components/Topbar.js";
import { RunBar } from "./components/RunBar.js";
import { CheckpointBanner } from "./components/CheckpointBanner.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { Card } from "./ui/index.js";

/**
 * Only the landing view is in the initial chunk. The rest split out — ContentPage
 * alone pulls in every form primitive, and most sessions never open Logs or
 * Settings at all.
 */
const ContentPage = lazy(() => import("./pages/ContentPage.js").then((m) => ({ default: m.ContentPage })));
const AccountsPage = lazy(() => import("./pages/AccountsPage.js").then((m) => ({ default: m.AccountsPage })));
const GroupsPage = lazy(() => import("./pages/GroupsPage.js").then((m) => ({ default: m.GroupsPage })));
const AudiencePage = lazy(() =>
  import("./pages/AudiencePage.js").then((m) => ({ default: m.AudiencePage })),
);
const RadarPage = lazy(() => import("./pages/RadarPage.js").then((m) => ({ default: m.RadarPage })));
const AnalyticsPage = lazy(() =>
  import("./pages/AnalyticsPage.js").then((m) => ({ default: m.AnalyticsPage })),
);
const LogsPage = lazy(() => import("./pages/LogsPage.js").then((m) => ({ default: m.LogsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const FeasibilityPage = lazy(() =>
  import("./pages/FeasibilityPage.js").then((m) => ({ default: m.FeasibilityPage })),
);

export function App() {
  const view = useStore((s) => s.view);
  const activeAccountId = useStore((s) => s.activeAccountId);

  // Everything the shell needs, once on mount.
  //
  // `bootstrapSession` is the one that matters: it establishes who is logged in, their
  // name and photo, and their groups — opening a background Facebook tab if that is
  // the only way, and closing it afterwards. Without it, a user with no Facebook tab
  // open gets a dashboard that knows nothing and asks them to add the account they are
  // already signed into.
  useEffect(() => {
    void loadAccounts();
    void bootstrapSession();
  }, []);

  // Groups follow whichever account the user is looking at.
  useEffect(() => {
    void primeGroups(activeAccountId);
  }, [activeAccountId]);

  return (
    <div className="flex h-full bg-surface">
      <ViewAnnouncer view={view} />
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Topbar />
        <RunBar />
        <div className="mx-auto max-w-6xl p-4 sm:p-6">
          {/*
            A checkpoint gates every Facebook call, not just a running campaign, so the
            way out of one belongs in the shell. It used to live only in RunBar, which
            renders only during a run — unreachable from the Groups page, which is
            exactly where a blocked group load sends you.
          */}
          <CheckpointBanner />
          {/* A new release, or the page opened right after one was installed. */}
          <UpdateBanner />
          {/* resetKey clears a caught error as soon as the user navigates away. */}
          <ErrorBoundary resetKey={view}>
            <Suspense fallback={<ViewFallback />}>{renderView(view)}</Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

/**
 * This is a single-page app: switching views replaces the whole page with no
 * navigation event, so nothing tells a screen reader anything changed. WCAG 4.1.3
 * / 2.4.2. The announcement is deferred a frame so it fires after the new view
 * has rendered, not before.
 */
function ViewAnnouncer({ view }: { view: ViewId }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");

  useEffect(() => {
    const id = requestAnimationFrame(() => setMessage(`${t(`nav.${view}`)} — ${t("app.name")}`));
    return () => cancelAnimationFrame(id);
  }, [view, t]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

function renderView(view: ViewId) {
  switch (view) {
    case "dashboard":
      return <DashboardPage />;
    case "content":
      return <ContentPage />;
    case "accounts":
      return <AccountsPage />;
    case "groups":
      return <GroupsPage />;
    case "audience":
      return <AudiencePage />;
    case "radar":
      return <RadarPage />;
    case "analytics":
      return <AnalyticsPage />;
    case "logs":
      return <LogsPage />;
    case "settings":
      return <SettingsPage />;
    case "feasibility":
      return <FeasibilityPage />;
    default:
      return <PlaceholderView />;
  }
}

function ViewFallback() {
  const { t } = useTranslation();
  return (
    <Card variant="filled" className="animate-pulse" aria-busy="true">
      <p className="text-body-medium text-on-surface-variant">{t("common.loading")}</p>
    </Card>
  );
}

function PlaceholderView() {
  const { t } = useTranslation();
  return (
    <Card variant="filled">
      <p className="text-body-medium text-on-surface-variant">{t("common.loading")}</p>
    </Card>
  );
}
