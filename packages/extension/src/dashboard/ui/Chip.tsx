import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";
import { cn } from "./cn.js";

export interface FilterChipProps {
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  children: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  className?: string;
}

/**
 * M3 filter chip: 32dp tall, small (8dp) shape, with a leading check that
 * appears on selection. Used wherever the UI offers a multi-select from a set.
 */
export function FilterChip({
  selected,
  onSelectedChange,
  children,
  icon,
  disabled,
  className,
}: FilterChipProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelectedChange(!selected)}
      className={cn(
        "state-layer inline-flex h-8 items-center gap-2 rounded-sm ps-3 pe-4 text-label-large",
        "transition-colors duration-short2 ease-standard",
        selected
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-outline text-on-surface-variant",
        disabled && "pointer-events-none border-on-surface/[0.12] text-on-surface/[0.38]",
        className,
      )}
    >
      {selected ? <Icon name="check" size={18} /> : icon ? <Icon name={icon} size={18} /> : null}
      <span>{children}</span>
    </button>
  );
}

export type StatusTone = "neutral" | "primary" | "success" | "warning" | "error";

const TONES: Record<StatusTone, string> = {
  neutral: "bg-surface-container-highest text-on-surface-variant",
  primary: "bg-primary-container text-on-primary-container",
  success: "bg-success-container text-on-success-container",
  warning: "bg-warning-container text-on-warning-container",
  error: "bg-error-container text-on-error-container",
};

export interface StatusChipProps {
  tone?: StatusTone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}

/**
 * Non-interactive status label — run state, post outcome, account health, risk level.
 *
 * Deliberately NOT called `Badge`: M3's Badge is the small notification dot on a
 * navigation item, which is a different thing. This is a static chip using the
 * container/on-container role pairs, including the harmonised success and warning
 * families that M3 baseline does not ship.
 */
export function StatusChip({ tone = "neutral", icon, children, className }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-label-medium",
        TONES[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}
