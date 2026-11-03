import { useTranslation } from "react-i18next";
import { useStore, type ViewId } from "../store.js";
import { Icon, type IconName, cn } from "../ui/index.js";
import logoMark from "../../assets/logos/logo.png";
import { appVersion } from "../appVersion.js";

const ITEMS: { id: ViewId; icon: IconName; key: string }[] = [
  { id: "dashboard", icon: "home", key: "nav.dashboard" },
  { id: "content", icon: "edit_note", key: "nav.content" },
  { id: "groups", icon: "groups", key: "nav.groups" },
  { id: "radar", icon: "bolt", key: "nav.radar" },
  { id: "audience", icon: "person", key: "nav.audience" },
  { id: "accounts", icon: "key", key: "nav.accounts" },
  { id: "analytics", icon: "monitoring", key: "nav.analytics" },
  { id: "logs", icon: "list_alt", key: "nav.logs" },
  { id: "settings", icon: "settings", key: "nav.settings" },
];

/**
 * M3 navigation, responsive across the two shapes the spec defines for a
 * persistent side nav:
 *
 *  - below lg: navigation rail — 80px, icon over label, no branding block.
 *  - lg and up: standard drawer — 280px, icon beside label.
 *
 * 280px rather than the spec's 360dp is a documented deviation: 360 eats too
 * much of a dashboard whose content column is already capped. The active
 * indicator is the M3 pill in both shapes.
 */
export function Sidebar() {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const version = appVersion();

  return (
    <aside className="flex w-20 shrink-0 flex-col bg-surface-container-low p-2 lg:w-[280px] lg:p-3">
      {/* The brand block would crowd the rail, so it appears only in drawer form. */}
      <div className="flex items-center gap-3 px-1 py-4 lg:px-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary-container mx-auto lg:mx-0">
          <img src={logoMark} alt="" className="h-7 w-7 object-contain" />
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className="truncate text-title-medium text-on-surface">{t("app.name")}</div>
          <div className="truncate text-body-small text-on-surface-variant">{t("app.tagline")}</div>
        </div>
      </div>

      <nav aria-label={t("nav.primary")} className="mt-2 flex flex-col gap-1">
        {ITEMS.map((it) => {
          const active = view === it.id;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setView(it.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "state-layer flex flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2",
                "text-label-medium transition-colors duration-short2 ease-standard",
                // Drawer form: a 56dp pill with the icon beside the label.
                "lg:h-14 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-full lg:px-4 lg:py-0",
                "lg:text-label-large lg:text-start",
                active
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-on-surface-variant",
              )}
            >
              <Icon name={it.icon} size={24} />
              <span className="max-w-full truncate">{t(it.key)}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto px-2 py-3 text-center text-body-small text-on-surface-variant lg:px-4 lg:text-start">
        <span className="hidden lg:inline">{t("app.version", { version })}</span>
        <span className="lg:hidden" dir="ltr">
          v{version}
        </span>
      </div>
    </aside>
  );
}
