import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon.js";
import { cn } from "./cn.js";

export type IconButtonVariant = "standard" | "filled" | "tonal";

const ENABLED: Record<IconButtonVariant, string> = {
  standard: "text-on-surface-variant",
  filled: "bg-primary text-on-primary",
  tonal: "bg-secondary-container text-on-secondary-container",
};

const DISABLED: Record<IconButtonVariant, string> = {
  standard: "text-on-surface/[0.38]",
  filled: "bg-on-surface/[0.12] text-on-surface/[0.38]",
  tonal: "bg-on-surface/[0.12] text-on-surface/[0.38]",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** Required: an icon-only control has no visible text to name it. */
  label: string;
  variant?: IconButtonVariant;
  size?: number;
}

/** M3 icon button: 40dp target, 24dp icon, full shape. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "standard", size = 24, className, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        // 40dp drawn, 48dp hit area (.touch-target) — M3 accessibility minimum. `size-10`, not
        // `h-10 w-10`: Tailwind emits it before any `h-*`/`w-*`, so a caller can shrink the button.
        "state-layer touch-target relative grid size-10 shrink-0 place-items-center rounded-full",
        disabled ? cn(DISABLED[variant], "pointer-events-none") : ENABLED[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});
