/**
 * Contact types — a phone number or email address parsed out of text somebody wrote.
 *
 * These live in `shared` rather than beside the parser because they cross every
 * boundary in the product: the engine produces them, the store persists them, the
 * dashboard renders them, and the CSV exporter flattens them.
 */

/**
 * ISO-3166 alpha-2 for the regions whose mobile plans we can resolve a bare national
 * number against. Adding one is a change to `contactExtract`'s table, not to callers.
 */
export type Region =
  | "SA"
  | "AE"
  | "EG"
  | "JO"
  | "KW"
  | "QA"
  | "BH"
  | "OM"
  | "MA"
  | "DZ"
  | "TN"
  | "IQ"
  | "LB"
  | "SY"
  | "PS"
  | "TR"
  | "YE"
  | "LY"
  | "SD";

export type ContactKind = "phone" | "email";

export interface Contact {
  kind: ContactKind;
  /** E.164 for a phone (`+966551234567`), lower-cased address for an email. */
  value: string;
  /**
   * 0..1. Not decoration: the difference between a number the author labelled
   * "واتساب" and a digit run that merely parses is the difference between a lead and
   * a complaint, so the UI filters on this and the exporter defaults to a floor.
   */
  confidence: number;
  /** Region a phone was resolved against, when one was inferred. */
  region?: Region;
  /** The substring this came from, so the operator can see why we think it is one. */
  raw: string;
  /** True when the number came from a wa.me / api.whatsapp.com link. */
  whatsapp?: boolean;
}
