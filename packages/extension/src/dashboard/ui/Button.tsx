import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon.js";
import { cn } from "./cn.js";

export type ButtonVariant = "filled" | "tonal" | "elevated" | "outlined" | "text";

/** Container + label colours per M3 button variant. */
const ENABLED: Record<ButtonVariant, string> = {
  filled: "bg-primary text-on-primary hover:shadow-1",
  tonal: "bg-secondary-container text-on-secondary-container hover:shadow-1",
  elevated: "bg-surface-container-low text-primary shadow-1 hover:shadow-2",
  outlined: "border border-outline text-primary",
  text: "text-primary",
};

/**
 * M3 disabled treatment: label at 38% of on-surface, container at 12%.
 * Spelled out per variant so no call site invents its own greyed-out styling.
 */
const DISABLED: Record<ButtonVariant, string> = {
  filled: "bg-on-surface/[0.12] text-on-surface/[0.38]",
  tonal: "bg-on-surface/[0.12] text-on-surface/[0.38]",
  elevated: "bg-on-surface/[0.12] text-on-surface/[0.38]",
  outlined: "border border-on-surface/[0.12] text-on-surface/[0.38]",
  text: "text-on-surface/[0.38]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  trailingIcon?: IconName;
}

/**
 * M3 common button: 40dp tall, full shape, label-large.
 *
 * Interaction states come from `.state-layer` rather than per-variant hover
 * colours, which is what keeps hover/focus/pressed consistent across variants.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", icon, trailingIcon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Inside a <form> an unspecified type submits; almost every button here is
      // an action, so the safe default is explicit.
      type={type ?? "button"}
      disabled={disabled}
      className={cn(
        "state-layer inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full",
        "text-label-large transition-shadow duration-short2 ease-standard",
        // M3 insets: 24dp, tightening to 16dp on the side that carries an icon.
        icon && !trailingIcon && "ps-4 pe-6",
        trailingIcon && !icon && "ps-6 pe-4",
        icon && trailingIcon && "px-4",
        !icon && !trailingIcon && "px-6",
        disabled ? cn(DISABLED[variant], "pointer-events-none shadow-none") : ENABLED[variant],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} />}
      <span>{children}</span>
      {trailingIcon && <Icon name={trailingIcon} size={18} />}
    </button>
  );
});
