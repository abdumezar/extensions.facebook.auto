import { useEffect } from "react";
import { IconButton } from "./IconButton.js";
import { cn } from "./cn.js";

export interface SnackbarProps {
  /** Renders nothing when empty, so callers can pass their error state directly. */
  message: string | null | undefined;
  onDismiss: () => void;
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay. Pass 0 to require an explicit dismissal. */
  durationMs?: number;
  dismissLabel?: string;
  className?: string;
}

/**
 * M3 snackbar: inverse-surface container, extra-small shape, elevation 3.
 *
 * Replaces the inline red error text the pages used to render, which had no
 * dismissal, no timeout, and nothing to announce it to a screen reader.
 * `role="status"` (polite) is deliberate — an error the user did not just cause
 * should not interrupt them mid-sentence.
 */
export function Snackbar({
  message,
  onDismiss,
  actionLabel,
  onAction,
  durationMs = 5000,
  dismissLabel = "Dismiss",
  className,
}: SnackbarProps) {
  useEffect(() => {
    if (!message || durationMs <= 0) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-4 start-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rtl:translate-x-1/2",
        "min-h-12 min-w-[288px] max-w-[560px] rounded-xs bg-inverse-surface ps-4 pe-2 py-2",
        "text-body-medium text-inverse-on-surface shadow-3",
        className,
      )}
    >
      <span className="flex-1">{message}</span>

      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="state-layer shrink-0 rounded-xs px-3 py-2 text-label-large text-inverse-primary"
        >
          <span>{actionLabel}</span>
        </button>
      )}

      <IconButton
        icon="close"
        label={dismissLabel}
        onClick={onDismiss}
        size={20}
        className="text-inverse-on-surface"
      />
    </div>
  );
}
