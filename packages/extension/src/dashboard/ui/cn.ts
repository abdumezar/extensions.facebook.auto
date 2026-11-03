export type ClassValue = string | false | null | undefined;

/** Joins class names, dropping falsy branches. Keeps conditional classes readable. */
export const cn = (...parts: ClassValue[]): string => parts.filter(Boolean).join(" ");
