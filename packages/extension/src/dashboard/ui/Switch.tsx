import { cn } from "./cn.js";
import { Icon } from "./Icon.js";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name. Pass `labelledBy` instead when a visible element names it. */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * M3 switch: 52x32 track, thumb reading as 16dp unselected and 24dp selected.
 *
 * A <button role="switch"> rather than a styled checkbox — the thumb/track
 * geometry needs real elements, and role="switch" is what tells assistive tech
 * this is an on/off control rather than a selection.
 *
 * The thumb is a fixed 24dp box that scales; animating `transform` keeps the
 * whole motion off the layout path, where animating width/height would not be.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  labelledBy,
  disabled,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full border-2",
        "transition-colors duration-short4 ease-emphasized",
        checked ? "border-primary bg-primary" : "border-outline bg-surface-container-highest",
        disabled &&
          "pointer-events-none border-on-surface/[0.12] bg-on-surface/[0.12] opacity-[0.38]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full",
          "transition-[transform,background-color] duration-short4 ease-emphasized",
          // Track inner width is 48px and the thumb box is 24px, so the selected
          // thumb travels exactly 24px. Unselected it scales to 16dp and sits 4px in.
          checked
            ? "translate-x-6 bg-on-primary text-primary rtl:-translate-x-6"
            : "translate-x-1 scale-[0.6667] bg-outline text-transparent rtl:-translate-x-1",
        )}
      >
        {checked && <Icon name="check" size={16} />}
      </span>
    </button>
  );
}
