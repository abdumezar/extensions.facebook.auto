import { useId } from "react";
import { cn } from "./cn.js";
import { Icon } from "./Icon.js";

export interface CheckboxProps {
  checked: boolean;
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
  onCheckedChange,
  label,
  labelledBy,
  disabled,
  className,
}: CheckboxProps) {
  const id = useId();

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
          checked
            ? "border-primary bg-primary text-on-primary"
            : "border-on-surface-variant text-transparent",
          disabled && "border-on-surface/[0.38] bg-transparent text-on-surface/[0.38]",
          disabled && checked && "border-transparent bg-on-surface/[0.38] text-surface",
        )}
      >
        {checked && <Icon name="check" size={14} />}
      </span>
    </span>
  );
}
