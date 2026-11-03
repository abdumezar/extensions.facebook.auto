/** Why a check for a newer release could not give an answer. */
export type UpdateError = "offline" | "rate_limited" | "no_release" | "unsigned_release";

/** A published release that is newer than the running version and carries a signature. */
export interface LatestRelease {
  version: string;
  /** ISO timestamp the release was published, when GitHub reports one. */
  publishedAt?: string;
  /** The release page, for the notes. Built by the extension, never taken from the response. */
  notesUrl: string;
  zipUrl: string;
  sigUrl: string;
}

/** The result of the last check for a newer release. */
export interface UpdateState {
  status: "idle" | "available" | "error";
  /** The version running when this state was recorded. */
  current: string;
  checkedAt?: number;
  error?: UpdateError;
  latest?: LatestRelease;
  /**
   * The most recent check could not get an answer (offline, rate limited, timed out)
   * while `latest` was still the last verified one. `checkedAt` stays the last success.
   */
  lastCheckFailed?: { error: UpdateError; at: number };
}

/** What is running that an update must not interrupt. */
export type BusyReason = "campaign" | "ramp" | "radar" | "engagement" | "extraction" | "groups";

/** Whether the service worker is in the middle of work a reload would cut short. */
export interface BusyState {
  busy: boolean;
  reason?: BusyReason;
}
