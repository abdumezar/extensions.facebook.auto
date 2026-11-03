import { forwardRef, useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn.js";

/**
 * M3 filled text field.
 *
 * The floating label is CSS-only: the input carries a single-space placeholder so
 * `:placeholder-shown` reports emptiness, and the label reacts through Tailwind's
 * `peer-*` variants. No JS focus/value tracking, so it cannot drift out of sync
 * with the real input state.
 *
 * Deliberate deviation from M3: the spec's filled field signals focus with a
 * bottom active indicator only. That is thinner than the 2px perimeter WCAG 2.2
 * §2.4.11 requires, so the global :focus-visible ring is kept on top of it
 * rather than suppressed with `outline-none`.
 */

/** 56dp tall; the asymmetric padding leaves room for the floated label. */
const INPUT_BASE = cn(
  "peer w-full rounded-t-xs bg-surface-container-highest px-4 pt-6 pb-2",
  "text-body-large text-on-surface caret-primary",
  "placeholder:text-transparent",
  "disabled:bg-on-surface/[0.04] disabled:text-on-surface/[0.38]",
);

const LABEL_BASE = cn(
  "pointer-events-none absolute start-4 top-2 origin-[0_0] whitespace-nowrap text-body-small",
  // Named properties, not `all` — `all` repaints on every inherited change.
  "transition-[top,font-size,line-height,color] duration-short3 ease-standard",
  // Resting position: vertically centred, at body-large.
  "peer-placeholder-shown:top-4 peer-placeholder-shown:text-body-large",
  // Floated again as soon as the field is focused.
  "peer-focus:top-2 peer-focus:text-body-small",
);

/** The M3 active indicator: 1dp at rest, 2dp and primary-coloured on focus. */
function Indicator({ error }: { error?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0",
        "transition-[height,background-color] duration-short3 ease-standard",
        // Height rather than border-width, so focus never shifts layout by 1px.
        // The element is absolutely positioned, so this reflows nothing else.
        "h-px peer-focus:h-0.5",
        error ? "bg-error peer-focus:bg-error" : "bg-on-surface-variant peer-focus:bg-primary",
      )}
    />
  );
}

interface FieldChrome {
  label: string;
  supportingText?: string;
  /** Presence switches the field into its error state and replaces the supporting text. */
  error?: string;
  className?: string;
}

/**
 * F-3: required must be visible, not only announced. The asterisk is aria-hidden
 * because the native `required` attribute already conveys it to assistive tech,
 * and a stray "star" reading is noise.
 */
function LabelText({ label, required }: { label: string; required?: boolean }) {
  return (
    <>
      {label}
      {required && (
        <span aria-hidden className="text-error">
          {" *"}
        </span>
      )}
    </>
  );
}

function labelClass(error?: string) {
  return cn(
    LABEL_BASE,
    error ? "text-error peer-focus:text-error" : "text-on-surface-variant peer-focus:text-primary",
  );
}

function Supporting({ id, error, supportingText }: { id: string } & FieldChrome) {
  const message = error ?? supportingText;
  if (!message) return null;
  return (
    <p
      id={id}
      className={cn("px-4 pt-1 text-body-small", error ? "text-error" : "text-on-surface-variant")}
    >
      {message}
    </p>
  );
}

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder">,
    FieldChrome {}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, supportingText, error, className, id, required, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const described = error ?? supportingText;

  return (
    <div className={className}>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          // A non-empty placeholder is what makes :placeholder-shown meaningful;
          // it is never visible (placeholder:text-transparent).
          placeholder=" "
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={described ? descId : undefined}
          className={INPUT_BASE}
          {...rest}
        />
        <label htmlFor={inputId} className={labelClass(error)}>
          <LabelText label={label} required={required} />
        </label>
        <Indicator error={Boolean(error)} />
      </div>
      <Supporting id={descId} label={label} supportingText={supportingText} error={error} />
    </div>
  );
});

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "placeholder">,
    FieldChrome {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, supportingText, error, className, id, rows = 3, required, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const described = error ?? supportingText;

  return (
    <div className={className}>
      <div className="relative">
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          placeholder=" "
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={described ? descId : undefined}
          className={cn(INPUT_BASE, "block resize-y")}
          {...rest}
        />
        {/* A textarea's label always floats — it has no single-line resting position. */}
        <label
          htmlFor={inputId}
          className={cn(
            "pointer-events-none absolute start-4 top-2 whitespace-nowrap text-body-small transition-colors",
            error ? "text-error" : "text-on-surface-variant peer-focus:text-primary",
          )}
        >
          <LabelText label={label} required={required} />
        </label>
        <Indicator error={Boolean(error)} />
      </div>
      <Supporting id={descId} label={label} supportingText={supportingText} error={error} />
    </div>
  );
});

export interface NumberFieldProps extends Omit<TextFieldProps, "type" | "value" | "onChange"> {
  value: number;
  onValueChange: (value: number) => void;
}

/**
 * TextField specialised for the numeric settings this app is full of. Keeps the
 * number/string conversion in one place instead of at every call site, and never
 * emits NaN when the field is mid-edit or empty.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { value, onValueChange, min = 0, ...rest },
  ref,
) {
  return (
    <TextField
      ref={ref}
      type="number"
      inputMode="numeric"
      min={min}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const next = Number(e.target.value);
        onValueChange(Number.isFinite(next) ? next : 0);
      }}
      {...rest}
    />
  );
});
