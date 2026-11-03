import { useEffect, useId, useRef } from "react";
import { cn } from "./cn.js";
import { Icon } from "./Icon.js";

export interface CheckboxProps {
  checked: boolean;
  /**
   * "Some, not all": a header box over a partly selected list. Drawn as a dash and exposed
   * through the native `indeterminate` property, which is what assistive tech reads. Only
   * meaningful while `checked` is false; a click still reports a plain checked value.
   */
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * M3 checkbox: an 18dp box inside a 40dp target.
 *
 * The native input stays in the DOM (visually hidden, not `display:none`) so it
 * keeps real checkbox semantics and keyboard behaviour; the visible box is
 * driven off `peer-*` state.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  labelledBy,
  disabled,
  className,
}: CheckboxProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // `indeterminate` exists only as a DOM property — React has no attribute to set it from.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  const mixed = indeterminate && !checked;

  return (
    <span
      className={cn(
        // 40dp drawn, 48dp hit area (.touch-target) — M3 accessibility minimum.
        "state-layer touch-target relative grid h-10 w-10 shrink-0 place-items-center rounded-full",
        disabled && "pointer-events-none",
        className,
      )}
    >
      <input
        ref={inputRef}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="peer absolute inset-0 z-20 cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span
        aria-hidden
        className={cn(
          "grid h-[18px] w-[18px] place-items-center rounded-[2px] border-2",
          "transition-colors duration-short2 ease-standard",
          checked || mixed
            ? "border-primary bg-primary text-on-primary"
            : "border-on-surface-variant text-transparent",
          disabled && "border-on-surface/[0.38] bg-transparent text-on-surface/[0.38]",
          disabled && checked && "border-transparent bg-on-surface/[0.38] text-surface",
        )}
      >
        {checked && <Icon name="check" size={14} />}
        {mixed && <span className="h-0.5 w-2.5 rounded-full bg-current" />}
      </span>
    </span>
  );
}
