import type { AudienceContact } from "@nashir/shared";
import { csvField } from "./analyticsRollup.js";

/**
 * audienceExport — flatten extracted people into a file. Pure.
 *
 * Reuses `csvField` from the analytics exporter rather than growing a second one:
 * that function neutralises spreadsheet formulas, and this export is the one that
 * carries the most attacker-controlled text in the whole product. Every name and
 * every comment body here was written by a stranger, and a display name of
 * `=cmd|'/c calc'!A1` is a live formula the moment the file opens in Excel.
 *
 * It also handles E.164: `+966…` starts with a formula lead character, so the same
 * apostrophe prefix that defuses the attack is what stops Excel mangling the number.
 */

/** One row per person. The shape a CRM import expects. */
export function toCsv(rows: AudienceContact[]): string {
  const header = [
    "name",
    "profileUrl",
    "userId",
    "phones",
    "emails",
    "whatsapp",
    "bestConfidence",
    "reactions",
    "comments",
    "sightings",
    "posts",
    "firstSeen",
    "lastSeen",
  ];

  const body = rows.map((r) => {
    const phones = r.contacts.filter((c) => c.kind === "phone");
    return [
      r.name,
      r.profileUrl ?? "",
      r.id,
      phones.map((c) => c.value).join(" | "),
      r.contacts
        .filter((c) => c.kind === "email")
        .map((c) => c.value)
        .join(" | "),
      phones
        .filter((c) => c.whatsapp)
        .map((c) => c.value)
        .join(" | "),
      r.bestConfidence.toFixed(2),
      [...new Set(r.sightings.map((s) => s.reaction).filter(Boolean))].join(" | "),
      // Newlines inside a quoted CSV field are legal and Excel reads them, but they
      // make the file unreadable in a diff or a terminal — so comments are joined.
      r.sightings
        .map((s) => s.text)
        .filter((t): t is string => !!t && t.length > 0)
        .join(" ⏎ "),
      String(r.sightings.length),
      [...new Set(r.sightings.map((s) => s.postUrl))].join(" | "),
      new Date(r.firstSeenAt).toISOString(),
      new Date(r.lastSeenAt).toISOString(),
    ]
      .map(csvField)
      .join(",");
  });

  return [header.join(","), ...body].join("\r\n");
}

/**
 * One row per *number*, for tools that take a contact list rather than a person list.
 *
 * Kept separate rather than folded into a flag on `toCsv` because the two files are
 * genuinely different documents: this one has no concept of a person with no phone,
 * and a person with three numbers is three rows.
 */
export function toPhoneCsv(rows: AudienceContact[]): string {
  const header = ["phone", "name", "profileUrl", "confidence", "whatsapp", "source", "lastSeen"];
  const body: string[] = [];
  for (const r of rows) {
    for (const c of r.contacts) {
      if (c.kind !== "phone") continue;
      body.push(
        [
          c.value,
          r.name,
          r.profileUrl ?? "",
          c.confidence.toFixed(2),
          c.whatsapp ? "yes" : "",
          r.sightings[0]?.source ?? "",
          new Date(r.lastSeenAt).toISOString(),
        ]
          .map(csvField)
          .join(","),
      );
    }
  }
  return [header.join(","), ...body].join("\r\n");
}

export function toJson(rows: AudienceContact[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * A wa.me click-to-chat link, with the message pre-filled.
 *
 * Click-to-chat and nothing more. Automating the *sending* would put this feature
 * inside WhatsApp's own automation rules and inside every anti-spam regime that
 * applies to them; handing the operator a prepared conversation does not.
 *
 * `wa.me` wants the number with no plus and no separators.
 */
export function whatsappLink(e164: string, template?: string, vars?: Record<string, string>): string {
  const digits = e164.replace(/\D/g, "");
  const base = `https://wa.me/${digits}`;
  const text = template ? fillTemplate(template, vars ?? {}) : "";
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/**
 * `{{name}}`-style substitution.
 *
 * An unknown placeholder is left standing rather than blanked: a message reading
 * "Hi {{name}}" is an obvious mistake the operator will catch, where "Hi ," looks
 * deliberate and gets sent.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}
