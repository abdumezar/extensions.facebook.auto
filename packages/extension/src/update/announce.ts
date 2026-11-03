/** The slice of `chrome.runtime.InstalledDetails` the decision needs. */
export interface InstalledDetails {
  reason: string;
  previousVersion?: string;
}

/**
 * Whether to open the dashboard to say "updated to X" after `onInstalled`.
 *
 * Chrome also fires `reason === "update"` when an unpacked extension is reloaded with
 * no change at all, and the updater itself reloads the extension; both would otherwise
 * pop a tab open for an update that did not happen.
 */
export function shouldAnnounceUpdate<T extends InstalledDetails>(
  details: T,
  currentVersion: string,
): details is T & { previousVersion: string } {
  return (
    details.reason === "update" &&
    !!details.previousVersion &&
    details.previousVersion !== currentVersion
  );
}
