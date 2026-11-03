import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon.js";
import { cn } from "./cn.js";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  headline: string;
  icon?: IconName;
  /** Supporting content. */
  children?: ReactNode;
  /** Action buttons, laid out end-aligned per M3. */
  actions?: ReactNode;
  className?: string;
}

/**
 * M3 basic dialog: extra-large (28dp) shape, surface-container-high, elevation 3.
 *
 * Owns the modal behaviour the previous hand-rolled overlays lacked — Escape to
 * close, a Tab focus trap, and focus restored to whatever opened it. Those are
 * the parts that are easy to leave out and hard for a user to work around.
 *
 * Renders through a portal to <body> and marks the app root `inert` while open.
 * A focus trap alone only constrains Tab; without inert, a screen reader's
 * virtual cursor still walks the page behind the dialog.
 */
export function Dialog({
  open,
  onClose,
  headline,
  icon,
  children,
  actions,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // The setup below must run when the dialog OPENS, not whenever the caller happens to
  // re-render. Most callers pass an inline arrow, so depending on `onClose` directly
  // would tear down and rebuild the trap on every render — stealing focus back to the
  // first control each time a dialog's own content updates (a fetch resolving, say).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();

    // Hide the rest of the app from assistive tech and pointer input. `inert` is
    // supported from Chrome 102; this extension requires 116.
    const appRoot = document.getElementById("root");
    appRoot?.setAttribute("inert", "");

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;

      // Wrap at both ends so focus can never escape the dialog into the page.
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      appRoot?.removeAttribute("inert");
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-scrim/[0.32] p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full min-w-[280px] max-w-[560px] rounded-xl bg-surface-container-high p-6",
          "shadow-3",
          className,
        )}
      >
        {icon && (
          <div className="mb-4 flex justify-center text-secondary">
            <Icon name={icon} size={24} />
          </div>
        )}

        <h2
          id={headingId}
          className={cn("text-headline-small text-on-surface", icon && "text-center")}
        >
          {headline}
        </h2>

        {children && <div className="mt-4 text-body-medium text-on-surface-variant">{children}</div>}

        {actions && <div className="mt-6 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
