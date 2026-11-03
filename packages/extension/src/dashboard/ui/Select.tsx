import { forwardRef, useId, type SelectHTMLAttributes } from "react";
import { Icon } from "./Icon.js";
import { cn } from "./cn.js";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  supportingText?: string;
}

/**
 * M3 filled select.
 *
 * Wraps a native <select> rather than reimplementing a menu: keyboard handling,
 * type-ahead, screen-reader semantics, and the platform's own touch UI all come
 * for free, and none of them are things a hand-rolled listbox gets right cheaply.
 * The label always floats, because a select always has a value.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, supportingText, className, id, children, disabled, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const descId = `${selectId}-desc`;

  return (
    <div className={className}>
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          disabled={disabled}
          aria-describedby={supportingText ? descId : undefined}
          className={cn(
            "peer w-full appearance-none rounded-t-xs bg-surface-container-highest",
            "ps-4 pe-10 pt-6 pb-2 text-body-large text-on-surface",
            "disabled:bg-on-surface/[0.04] disabled:text-on-surface/[0.38]",
          )}
          {...rest}
        >
          {children}
        </select>

        <label
          htmlFor={selectId}
          className={cn(
            "pointer-events-none absolute start-4 top-2 whitespace-nowrap text-body-small transition-colors",
            "text-on-surface-variant peer-focus:text-primary",
          )}
        >
          {label}
        </label>

        <Icon
          name="expand_more"
          size={24}
          className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
        />

        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-on-surface-variant",
            "transition-[height,background-color] duration-short3 ease-standard",
            "peer-focus:h-0.5 peer-focus:bg-primary",
          )}
        />
      </div>

      {supportingText && (
        <p id={descId} className="px-4 pt-1 text-body-small text-on-surface-variant">
          {supportingText}
        </p>
      )}
    </div>
  );
});
