import { cn } from "./cn.js";

export interface LinearProgressProps {
  /** 0-100. Omit for an indeterminate bar. */
  value?: number;
  label?: string;
  className?: string;
}

/** M3 linear progress indicator: 4dp track. */
export function LinearProgress({ value, label, className }: LinearProgressProps) {
  const determinate = typeof value === "number";
  const pct = determinate ? Math.min(100, Math.max(0, value)) : undefined;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? pct : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-secondary-container", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary",
          determinate
            ? "transition-[width] duration-medium2 ease-emphasized"
            : "w-1/3 animate-[md-indeterminate_1.6s_infinite] ease-standard",
        )}
        style={determinate ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}
