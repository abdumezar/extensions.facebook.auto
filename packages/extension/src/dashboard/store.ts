import { create } from "zustand";
import {
  CURRENT_SESSION,
  type Account,
  type Group,
  type DelayConfig,
  type SafetyBreakConfig,
  type AntiDetectionConfig,
  type RunSnapshot,
  type CampaignMedia,
  type SessionStatus,
} from "@nashir/shared";

/**
 * `feasibility` is deliberately absent from the sidebar (see `Sidebar.tsx`): it posts to
 * real groups for real, and is reached only from Settings → Diagnostics.
 */
export type ViewId =
  | "dashboard"
  | "content"
  | "groups"
  | "audience"
  | "radar"
  | "accounts"
  | "analytics"
  | "logs"
  | "settings"
  | "feasibility";

export interface CampaignDraft {
  variations: string[];
  delay: DelayConfig;
  safetyBreak: SafetyBreakConfig;
  antiDetection: AntiDetectionConfig;
  /** Extra group ids typed by hand (one per line), merged with table selection. */
  manualGroupIds: string;
  /** Images/videos attached to every post, stored as blobs in MediaStore. */
  media: CampaignMedia[];
  /**
   * Which link found in the captions gets the preview card. Undefined = none; Facebook
   * attaches at most one, and media outranks it.
   */
  linkUrl?: string;
  /** Posted as the first comment on every post that lands. Empty = none. */
  firstComment: string;
}

export const DEFAULT_DRAFT: CampaignDraft = {
  variations: [""],
  delay: { mode: "range", minSeconds: 60, maxSeconds: 180 },
  safetyBreak: { enabled: false, everyNPosts: 25, durationSeconds: 300 },
  antiDetection: {
    jitter: true,
    warmup: true,
    dailyBudgetPerAccount: 0,
    autoPauseAfterConsecutiveFailures: 3,
  },
  manualGroupIds: "",
  media: [],
  firstComment: "",
};

interface DashboardState {
  view: ViewId;
  setView: (v: ViewId) => void;

  accounts: Account[];
  setAccounts: (a: Account[]) => void;

  /** Which account the Groups page reads from. `CURRENT_SESSION` = this browser's login. */
  activeAccountId: string;
  setActiveAccount: (id: string) => void;

  /** The live browser session, as last probed by the service worker. */
  session: SessionStatus | null;
  setSession: (s: SessionStatus | null) => void;

  groups: Group[];
  /** When the shown groups were last fetched from Facebook (0 = never). */
  groupsSyncedAt: number;
  /** True while Facebook still has groups the walk has not reached. */
  groupsIncomplete: boolean;
  setGroups: (g: Group[], syncedAt?: number, incomplete?: boolean) => void;

  selectedGroupIds: Set<string>;
  toggleGroup: (id: string) => void;
  setSelectedGroups: (ids: string[]) => void;
  clearSelection: () => void;

  /** Managed accounts to post from. Empty => the current browser session. */
  selectedAccountIds: Set<string>;
  toggleAccount: (id: string) => void;
  clearAccountSelection: () => void;

  draft: CampaignDraft;
  updateDraft: (patch: Partial<CampaignDraft>) => void;

  snapshot: RunSnapshot | null;
  setSnapshot: (s: RunSnapshot | null) => void;

  fbTabCount: number;
  setFbTabCount: (n: number) => void;
}

export const useStore = create<DashboardState>((set) => ({
  view: "dashboard",
  setView: (view) => set({ view }),

  accounts: [],
  setAccounts: (accounts) => set({ accounts }),

  activeAccountId: CURRENT_SESSION,
  setActiveAccount: (activeAccountId) => set({ activeAccountId }),

  session: null,
  setSession: (session) => set({ session }),

  groups: [],
  groupsSyncedAt: 0,
  groupsIncomplete: false,
  setGroups: (groups, syncedAt, incomplete) =>
    set((s) => ({
      groups,
      groupsSyncedAt: syncedAt ?? s.groupsSyncedAt,
      groupsIncomplete: incomplete ?? s.groupsIncomplete,
    })),

  selectedGroupIds: new Set(),
  toggleGroup: (id) =>
    set((s) => {
      const next = new Set(s.selectedGroupIds);
      next.has(id) ? next.delete(id) : next.add(id);
      return { selectedGroupIds: next };
    }),
  setSelectedGroups: (ids) => set({ selectedGroupIds: new Set(ids) }),
  clearSelection: () => set({ selectedGroupIds: new Set() }),

  selectedAccountIds: new Set(),
  toggleAccount: (id) =>
    set((s) => {
      const next = new Set(s.selectedAccountIds);
      next.has(id) ? next.delete(id) : next.add(id);
      return { selectedAccountIds: next };
    }),
  clearAccountSelection: () => set({ selectedAccountIds: new Set() }),

  draft: DEFAULT_DRAFT,
  updateDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),

  fbTabCount: 0,
  setFbTabCount: (fbTabCount) => set({ fbTabCount }),
}));

/**
 * The group ids a run would target: table selection plus anything pasted by hand.
 * One definition, because the Content page, the home page and the run bar must all
 * agree on the count the user is about to act on.
 */
export function resolveGroupIds(selected: Set<string>, manual: string): string[] {
  const typed = manual.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([...selected, ...typed]));
}
