import { describe, it, expect } from "vitest";
import { GroupLeaveService } from "./GroupLeaveService.js";
import { GroupService } from "./GroupService.js";
import { DEFAULT_FB_RECIPE, type SessionTokens } from "@nashir/shared";
import type { HttpPort, StoragePort, LoggerPort } from "./ports/index.js";

const tokens: SessionTokens = {
  fb_dtsg: "d",
  jazoest: "2",
  lsd: "l",
  user: "100",
  av: "100",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "15",
  scrapedAt: 0,
};
const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

/** Captures every request body so tests can assert on the wire shape. */
function recordingHttp(bodies: string[]) {
  const sent: URLSearchParams[] = [];
  let i = 0;
  const http: HttpPort = {
    fetch: async (_url, init) => {
      sent.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(bodies[i++] ?? "{}", { status: 200 });
    },
  };
  return { http, sent };
}

/** Response shape of a leave that only removed the viewer (HAR, 2026-08-22). */
const LEFT = JSON.stringify({
  data: { group_leave: { group: { id: "111111", is_viewer_member: false } } },
});
/** Response shape when the viewer was the last member — the group node is gone. */
const DELETED = JSON.stringify({ data: { group_leave: { group: null, viewer: {} } } });

async function seed(storage: StoragePort, groups: { id: string; name: string }[]) {
  await storage.set("nashir:groups:acc", { accountId: "acc", groups, syncedAt: 1 });
}

type FakeGovernor = { cooldown(): Promise<{ reason: string } | null> };

function build(
  bodies: string[],
  storage = memStorage(),
  governor?: FakeGovernor,
) {
  const { http, sent } = recordingHttp(bodies);
  const groups = new GroupService(storage, http, noopLogger, async () => {});
  const leave = new GroupLeaveService(
    groups,
    http,
    noopLogger,
    async () => {},
    () => 0.5,
    governor,
  );
  return { leave, groups, storage, sent };
}

describe("GroupLeaveService.preview", () => {
  it("reads Facebook's own leave-dialog warnings", async () => {
    const body = JSON.stringify({
      data: {
        group: {
          id: "111111",
          name: "Test Group",
          url: "https://www.facebook.com/groups/111111/",
          viewer_leave_info: { confirmation_title: "Are you sure?", leave_scenario: "MEMBER_NOTIFICATIONS" },
          leave_text: { text: "Leave group" },
          canDelete: null,
          will_group_delete_when_last_member_leaves: true,
          visibility: "CLOSED",
        },
      },
    });
    const { leave, sent } = build([body]);

    const preview = await leave.preview("111111", tokens, DEFAULT_FB_RECIPE);

    expect(preview).toMatchObject({
      groupId: "111111",
      name: "Test Group",
      confirmationTitle: "Are you sure?",
      leaveLabel: "Leave group",
      leaveScenario: "MEMBER_NOTIFICATIONS",
      visibility: "CLOSED",
      deletesGroupWhenLastMemberLeaves: true,
      // `canDelete: null` is NOT an offer to delete.
      canDelete: false,
    });
    expect(sent[0]?.get("doc_id")).toBe(DEFAULT_FB_RECIPE.leaveGroupDialog?.docId);
    expect(sent[0]?.get("variables")).toBe('{"groupID":"111111"}');
  });

  it("throws when Facebook returns an error", async () => {
    const { leave } = build([JSON.stringify({ errors: [{ message: "Bad doc_id" }] })]);
    await expect(leave.preview("111111", tokens, DEFAULT_FB_RECIPE)).rejects.toThrow("Bad doc_id");
  });
});

describe("GroupLeaveService.leave", () => {
  it("sends the captured mutation shape and reports a plain leave", async () => {
    const storage = memStorage();
    await seed(storage, [{ id: "111111", name: "Test Group" }, { id: "222222", name: "Other" }]);
    const { leave, groups, sent } = build([LEFT], storage);

    const result = await leave.leave("acc", "111111", tokens, DEFAULT_FB_RECIPE);

    expect(result).toMatchObject({ groupId: "111111", name: "Test Group", outcome: "left" });
    const vars = JSON.parse(sent[0]!.get("variables")!);
    expect(vars.groupID).toBe("111111");
    expect(vars.input).toMatchObject({
      action_source: "COMET_GROUP_PAGE",
      group_id: "111111",
      readd_policy: "ALLOW_READD",
      actor_id: "100",
    });
    expect(vars.ordering).toEqual(["viewer_added"]);
    expect(sent[0]?.get("doc_id")).toBe(DEFAULT_FB_RECIPE.leaveGroup?.docId);
    expect(sent[0]?.get("fb_api_req_friendly_name")).toBe("useGroupLeaveMutation");

    // The group we left is gone from the cache; the other one survives.
    expect((await groups.getGroups("acc")).map((g) => g.id)).toEqual(["222222"]);
  });

  it("reports a deleted group when the node comes back null", async () => {
    const storage = memStorage();
    await seed(storage, [{ id: "111111", name: "My Own Group" }]);
    const { leave, groups } = build([DELETED], storage);

    const result = await leave.leave("acc", "111111", tokens, DEFAULT_FB_RECIPE);

    expect(result).toMatchObject({ groupId: "111111", name: "My Own Group", outcome: "deleted" });
    expect(await groups.getGroups("acc")).toEqual([]);
  });

  it("does not claim success — or drop the cache entry — when membership did not change", async () => {
    const storage = memStorage();
    await seed(storage, [{ id: "111111", name: "Test Group" }]);
    const stillMember = JSON.stringify({
      data: { group_leave: { group: { id: "111111", is_viewer_member: true } } },
    });
    const { leave, groups } = build([stillMember], storage);

    const result = await leave.leave("acc", "111111", tokens, DEFAULT_FB_RECIPE);

    expect(result.outcome).toBe("failed");
    expect((await groups.getGroups("acc")).map((g) => g.id)).toEqual(["111111"]);
  });

  it("reads a null group_leave payload as a failure, never as a deletion", async () => {
    const { leave } = build([JSON.stringify({ data: { group_leave: null } })]);
    const result = await leave.leave("acc", "111111", tokens, DEFAULT_FB_RECIPE);
    expect(result.outcome).toBe("failed");
  });

  it("surfaces a Facebook error instead of throwing", async () => {
    const { leave } = build([JSON.stringify({ errors: [{ message: "Rate limited" }] })]);
    const result = await leave.leave("acc", "111111", tokens, DEFAULT_FB_RECIPE);
    expect(result).toMatchObject({ outcome: "failed", error: "Rate limited" });
  });
});

describe("GroupLeaveService.leaveMany", () => {
  it("leaves each group in order and reports every outcome", async () => {
    const storage = memStorage();
    await seed(storage, [
      { id: "111111", name: "A" },
      { id: "222222", name: "B" },
      { id: "333333", name: "C" },
    ]);
    const { leave, groups } = build([LEFT, DELETED, LEFT], storage);

    const results = await leave.leaveMany("acc", ["111111", "222222", "333333"], tokens, DEFAULT_FB_RECIPE);

    expect(results.map((r) => r.outcome)).toEqual(["left", "deleted", "left"]);
    expect(await groups.getGroups("acc")).toEqual([]);
  });

  it("stops after three consecutive failures and marks the rest skipped", async () => {
    const err = JSON.stringify({ errors: [{ message: "nope" }] });
    const { leave, sent } = build([err, err, err, LEFT, LEFT]);

    const results = await leave.leaveMany("acc", ["1", "2", "3", "4", "5"], tokens, DEFAULT_FB_RECIPE);

    expect(results.map((r) => r.outcome)).toEqual(["failed", "failed", "failed", "skipped", "skipped"]);
    // Only the three attempts went out — the skipped groups were never requested.
    expect(sent).toHaveLength(3);
  });

  it("aborts immediately on an expired token rather than burning the whole batch", async () => {
    const expired = JSON.stringify({
      errors: [{ message: DEFAULT_FB_RECIPE.tokenExpiredSignals[0] }],
    });
    const { leave, sent } = build([expired, LEFT, LEFT]);

    const results = await leave.leaveMany("acc", ["1", "2", "3"], tokens, DEFAULT_FB_RECIPE);

    expect(results.map((r) => r.outcome)).toEqual(["failed", "skipped", "skipped"]);
    expect(sent).toHaveLength(1);
  });

  it("keeps going after an isolated failure", async () => {
    const err = JSON.stringify({ errors: [{ message: "nope" }] });
    const { leave } = build([LEFT, err, LEFT]);
    const results = await leave.leaveMany("acc", ["1", "2", "3"], tokens, DEFAULT_FB_RECIPE);
    expect(results.map((r) => r.outcome)).toEqual(["left", "failed", "left"]);
  });
});

describe("GroupLeaveService respects a live block", () => {
  it("stops the batch and reports the rest as skipped, not attempted", async () => {
    const storage = memStorage();
    await seed(storage, [
      { id: "111111", name: "A" },
      { id: "222222", name: "B" },
      { id: "333333", name: "C" },
    ]);
    // Blocked from the start: leaving is irreversible, so nothing should be tried.
    const { leave, sent } = build([LEFT, LEFT, LEFT], storage, {
      cooldown: async () => ({ reason: "rate_limit" }),
    });

    const results = await leave.leaveMany("acc", ["111111", "222222", "333333"], tokens, DEFAULT_FB_RECIPE);

    expect(sent).toHaveLength(0);
    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped", "skipped"]);
    expect(results[0]!.error).toMatch(/pause/i);
    // The names still resolve, so the report is readable rather than a list of ids.
    expect(results[0]!.name).toBe("A");
  });

  it("runs the whole batch when nothing is blocking", async () => {
    const storage = memStorage();
    await seed(storage, [
      { id: "111111", name: "A" },
      { id: "222222", name: "B" },
    ]);
    const { leave, sent } = build([LEFT, LEFT], storage, { cooldown: async () => null });

    const results = await leave.leaveMany("acc", ["111111", "222222"], tokens, DEFAULT_FB_RECIPE);

    expect(sent).toHaveLength(2);
    expect(results.every((r) => r.outcome !== "skipped")).toBe(true);
  });
});
