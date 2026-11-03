import { ICON_PATHS, ICON_VIEW_BOX, type IconName } from "./icons.generated.js";
import { cn } from "./cn.js";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** Rendered size in px. M3 uses 24dp in most places, 18dp inside buttons. */
  size?: number;
  className?: string;
  /**
   * Accessible name. Provide it only when the icon is the sole content of a
   * control; beside a visible label the icon is decorative and must stay hidden
   * from assistive tech so the label is not announced twice.
   */
  label?: string;
}

export function Icon({ name, size = 24, className, label }: IconProps) {
  return (
    <svg
      viewBox={ICON_VIEW_BOX}
      width={size}
      height={size}
      className={cn("shrink-0 fill-current", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
