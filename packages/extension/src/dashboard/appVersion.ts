import { version as packageVersion } from "../../package.json";

/**
 * The version of the installed extension. It comes from the manifest Chrome loaded, so it
 * is right after an update too; outside an extension page (tests, a plain browser tab) it
 * is the package version, which the manifest is built from.
 */
export function appVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return packageVersion;
  }
}
