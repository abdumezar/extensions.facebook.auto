import { useRef, type KeyboardEvent } from "react";
import { Icon } from "./Icon.js";
import { cn } from "./cn.js";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedButtonProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the group as a whole. */
  label: string;
  className?: string;
}

/**
 * M3 single-select segmented button: 40dp tall, outlined, full shape on the outer
 * ends, with a check on the active segment.
 *
 * Implements the full ARIA radiogroup pattern, not just the roles: roving
 * tabindex (the group is one tab stop, not N) and arrow-key navigation that
 * wraps. Declaring role="radio" without these promises assistive tech an
 * interaction model that would not actually work.
 *
 * Arrow direction follows the writing direction, so Left/Right stay intuitive
 * in RTL.
 */
export function SegmentedButton<T extends string>({
  options,
  value,
  onValueChange,
  label,
  className,
}: SegmentedButtonProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(from: number, delta: number) {
    const next = (from + delta + options.length) % options.length;
    const opt = options[next];
    if (!opt) return;
    onValueChange(opt.value);
    refs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const forward = rtl ? -1 : 1;

    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        move(index, forward);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(index, -forward);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(index, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(index, -1);
        break;
      case "Home":
        e.preventDefault();
        move(0, 0);
        break;
      case "End":
        e.preventDefault();
        move(options.length - 1, 0);
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex h-10 overflow-hidden rounded-full border border-outline", className)}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the whole group is a single tab stop.
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              "state-layer inline-flex items-center justify-center gap-1.5 px-3 text-label-large",
              "transition-colors duration-short2 ease-standard",
              // Logical border so the divider lands correctly in RTL.
              i > 0 && "border-s border-outline",
              selected ? "bg-secondary-container text-on-secondary-container" : "text-on-surface",
            )}
          >
            {selected && <Icon name="check" size={18} />}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
