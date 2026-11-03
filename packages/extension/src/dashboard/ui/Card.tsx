import type { HTMLAttributes } from "react";
import { cn } from "./cn.js";

export type CardVariant = "elevated" | "filled" | "outlined";

const VARIANTS: Record<CardVariant, string> = {
  elevated: "bg-surface-container-low shadow-1",
  filled: "bg-surface-container-highest",
  outlined: "bg-surface border border-outline-variant",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Drops the default 16dp inset for cards that manage their own padding. */
  flush?: boolean;
}

/** M3 card: medium (12dp) shape, 16dp inset. */
export function Card({ variant = "outlined", flush, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn("rounded-md text-on-surface", VARIANTS[variant], !flush && "p-4", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
