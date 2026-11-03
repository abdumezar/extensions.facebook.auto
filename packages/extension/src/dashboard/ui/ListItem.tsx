import type { ReactNode } from "react";
import { cn } from "./cn.js";

export interface ListItemProps {
  headline: ReactNode;
  supportingText?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Renders as a button and enables interaction states. */
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}

/** M3 list item: 56dp one-line, 72dp two-line, with leading and trailing slots. */
export function ListItem({
  headline,
  supportingText,
  leading,
  trailing,
  onClick,
  selected,
  className,
}: ListItemProps) {
  const content = (
    <>
      {leading && <span className="shrink-0 text-on-surface-variant">{leading}</span>}
      <span className="min-w-0 flex-1 text-start">
        <span className="block truncate text-body-large text-on-surface">{headline}</span>
        {supportingText && (
          <span className="block truncate text-body-medium text-on-surface-variant">
            {supportingText}
          </span>
        )}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </>
  );

  const shared = cn(
    "flex w-full items-center gap-4 px-4",
    supportingText ? "min-h-[72px] py-2" : "min-h-14 py-1",
    selected && "bg-secondary-container",
    className,
  );

  if (!onClick) return <div className={shared}>{content}</div>;

  return (
    <button type="button" onClick={onClick} className={cn("state-layer", shared)}>
      {content}
    </button>
  );
}
