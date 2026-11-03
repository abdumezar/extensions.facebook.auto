/**
 * Runs inside the Facebook page (MAIN world), not in the extension.
 *
 * `chrome.scripting.executeScript` serialises this function with `toString()` and
 * evaluates the text in the page, so it must stay self-contained: no imports, no
 * helpers, nothing from the enclosing module. Each relay operation is a module named
 * `<friendlyName>_facebookRelayOperation` whose export is its current doc_id.
 *
 * Calling `require` for a module that is not loaded returns `undefined` quietly, so
 * names are looked up directly and a throw is simply skipped.
 */
export function harvestLookup(names: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (!Array.isArray(names) || typeof (window as any).require !== "function") return found;
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    try {
      const value = (window as any).require(name + "_facebookRelayOperation");
      if (typeof value === "string") {
        found[name] = value;
      } else if (typeof value === "number" && Number.isSafeInteger(value)) {
        // Ids run past 2^53, so a number that is not a safe integer has already been
        // rounded by the page. A rounded id must never become an override.
        found[name] = String(value);
      }
    } catch {
      // Not defined on this page; the operation simply is not loaded here.
    }
  }
  return found;
}
