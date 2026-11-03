import { DEFAULT_FB_RECIPE } from "@nashir/shared";
import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/audience.json";
import {
  commentSighting,
  decodeFeedbackTarget,
  encodeFeedbackTarget,
  findFeedbackId,
  findGroupId,
  parseActor,
  parseComments,
  parsePostUrl,
  parseReactors,
  reactionName,
  reactorSighting,
} from "./audienceParse.js";

const R = DEFAULT_FB_RECIPE;
const f = fixtures as Record<string, unknown>;

describe("parseReactors — against the shape Facebook actually returned", () => {
  const page = parseReactors(f["reactorsPage"]);

  it("reads every reactor in the page", () => {
    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.actor.name).toBeTruthy();
    expect(page.items[0]?.actor.id).toMatch(/^\d+$/);
  });

  it("keeps the profile url and avatar", () => {
    expect(page.items[0]?.actor.profileUrl).toContain("facebook.com");
    expect(page.items[0]?.actor.profilePicUrl).toBeTruthy();
  });

  it("keeps the reaction id, unmapped", () => {
    expect(page.items[0]?.reactionId).toBe("1635855486666999");
  });

  it("reads the cursor and has_next_page", () => {
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBeTruthy();
  });

  it("finds the connection even when the known path is gone", () => {
    // The whole point of the tolerant walk: Facebook moves the path, not the leaf.
    const moved = { data: { somethingNew: { wrapper: (f["reactorsPage"] as any).data.node } } };
    expect(parseReactors(moved).items).toHaveLength(3);
  });

  it("returns an empty page rather than throwing on junk", () => {
    expect(parseReactors({}).items).toEqual([]);
    expect(parseReactors(null).hasNextPage).toBe(false);
    expect(parseReactors({ data: { node: { reactors: { edges: [], page_info: {} } } } }).items).toEqual(
      [],
    );
  });
});

describe("parseComments", () => {
  const page = parseComments(f["commentsFirstPage"]);

  it("reads the comments with their authors and text", () => {
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.text).toContain("0501234567");
    expect(page.items[0]?.actor.name).toBeTruthy();
  });

  it("reads depth, created_time and the comment id", () => {
    expect(page.items[0]?.depth).toBe(0);
    expect(page.items[0]?.createdAt).toBeGreaterThan(1_000_000_000);
    expect(page.items[0]?.commentId).toBeTruthy();
  });

  it("reads Facebook's own total_count", () => {
    expect(page.totalCount).toBe(30);
  });

  it("pages", () => {
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBeTruthy();
  });

  it("reads the pagination response, which nests the connection elsewhere", () => {
    const next = parseComments(f["commentsNextPage"]);
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items[0]?.actor.id).toMatch(/^\d+$/);
  });

  it("survives a comment with no body", () => {
    const body = {
      data: {
        node: {
          comment_rendering_instance_for_feed_location: {
            comments: {
              edges: [{ node: { id: "c1", body: null, author: { id: "123456789", name: "X" } } }],
              page_info: { has_next_page: false },
            },
          },
        },
      },
    };
    const out = parseComments(body);
    expect(out.items[0]?.text).toBe("");
  });
});

describe("parseActor", () => {
  it("rejects a named node that is not a person", () => {
    // Text ranges carry `id` + a name-ish field; a short or non-numeric id is the tell.
    expect(parseActor({ id: "abc", name: "ExternalUrl" })).toBeUndefined();
    expect(parseActor({ id: "42", name: "Nope" })).toBeUndefined();
    expect(parseActor({ id: "123456789" })).toBeUndefined();
  });

  it("accepts either avatar key", () => {
    expect(
      parseActor({ id: "123456789", name: "A", profile_picture_depth_0: { uri: "u" } })
        ?.profilePicUrl,
    ).toBe("u");
  });
});

describe("feedback ids", () => {
  it("round-trips the encoded target Facebook uses", () => {
    expect(encodeFeedbackTarget("1530000000000001")).toBe("ZmVlZGJhY2s6MTUzMDAwMDAwMDAwMDAwMQ==");
    expect(decodeFeedbackTarget("ZmVlZGJhY2s6MTUzMDAwMDAwMDAwMDAwMQ==")).toBe("1530000000000001");
  });

  it("refuses a token that decodes to something else", () => {
    expect(decodeFeedbackTarget(btoa("story:123"))).toBeUndefined();
    expect(decodeFeedbackTarget("not base64 !!")).toBeUndefined();
  });

  it("finds the encoded target in page html", () => {
    const html = `<script>{"x":1,"target":"ZmVlZGJhY2s6MTUzMDAwMDAwMDAwMDAwMQ=="}</script>`;
    expect(findFeedbackId(html)).toBe("1530000000000001");
  });

  it("falls back to a named field, then to a feedback object", () => {
    expect(findFeedbackId(`"feedback_target_id":"998877665544"`)).toBe("998877665544");
    expect(findFeedbackId(`"feedback":{"id":"112233445566"}`)).toBe("112233445566");
  });

  it("returns undefined when the page carries nothing usable", () => {
    expect(findFeedbackId("<html>login</html>")).toBeUndefined();
  });
});

describe("findGroupId", () => {
  it("reads the numeric id out of a group page, whichever field carries it", () => {
    expect(findGroupId('{"groupID":"1234567890"}')).toBe("1234567890");
    expect(findGroupId('{"group_id":"1234567890"}')).toBe("1234567890");
    expect(findGroupId('href="/groups/1234567890/"')).toBe("1234567890");
    expect(findGroupId('{"__typename":"Group","id":"1234567890"}')).toBe("1234567890");
  });

  it("ignores a short number that cannot be a group id", () => {
    expect(findGroupId('{"groupID":"12"}')).toBeUndefined();
  });

  it("returns undefined rather than guessing", () => {
    expect(findGroupId("<html>nothing here</html>")).toBeUndefined();
  });
});

describe("parsePostUrl — every permalink shape in the recipe", () => {
  const cases: Array<[string, string, string | undefined]> = [
    // The shape that used to be rejected outright: most groups are reached by a
    // vanity slug, and requiring digits for the group segment failed the majority of
    // real group post links.
    [
      "https://www.facebook.com/groups/examplegroup/posts/1234567890123456",
      "1234567890123456",
      "examplegroup",
    ],
    ["https://www.facebook.com/groups/123456/posts/987654/", "987654", "123456"],
    ["https://www.facebook.com/groups/123456/permalink/987654/", "987654", "123456"],
    [
      "https://www.facebook.com/groups/examplegroup/permalink/987654/",
      "987654",
      "examplegroup",
    ],
    // A group slug may carry dots and hyphens.
    ["https://www.facebook.com/groups/my.group-name/posts/123456/", "123456", "my.group-name"],
    // A group post id is usually numeric but pfbid turns up on shared links.
    ["https://www.facebook.com/groups/somegroup/posts/pfbid0abc/", "pfbid0abc", "somegroup"],
    [
      "https://www.facebook.com/groups/somegroup/?multi_permalinks=1234567890123456",
      "1234567890123456",
      "somegroup",
    ],
    // Mobile and the regional web host are the same page.
    ["https://m.facebook.com/groups/somegroup/posts/987654", "987654", "somegroup"],
    ["https://web.facebook.com/groups/somegroup/posts/987654", "987654", "somegroup"],
    // A comment deep-link is still the same post.
    ["https://www.facebook.com/groups/somegroup/posts/987654/?comment_id=99", "987654", "somegroup"],
    ["https://www.facebook.com/permalink.php?story_fbid=555666&id=777", "555666", undefined],
    ["https://www.facebook.com/somepage/posts/pfbid0abc123", "pfbid0abc123", undefined],
    ["https://www.facebook.com/someone/videos/321321/", "321321", undefined],
    ["https://www.facebook.com/photo?fbid=444555&set=a.1", "444555", undefined],
    ["https://www.facebook.com/video.php?fbid=444555", "444555", undefined],
    ["https://www.facebook.com/share/p/AbCd123/", "AbCd123", undefined],
  ];

  for (const [url, story, group] of cases) {
    it(url, () => {
      const out = parsePostUrl(url, R);
      expect(out.storyId).toBe(story);
      expect(out.groupId).toBe(group);
    });
  }

  it("does not mistake parent_story_fbid for story_fbid", () => {
    const out = parsePostUrl("https://www.facebook.com/permalink.php?parent_story_fbid=111", R);
    expect(out.storyId).toBeUndefined();
  });

  it("returns nothing for a url that is not a post", () => {
    expect(parsePostUrl("https://www.facebook.com/groups/123456/", R).storyId).toBeUndefined();
    expect(parsePostUrl("https://www.facebook.com/groups/examplegroup/", R).storyId).toBeUndefined();
    expect(parsePostUrl("https://www.facebook.com/", R).storyId).toBeUndefined();
    expect(parsePostUrl("not a url", R).storyId).toBeUndefined();
  });

  it("does not match a lookalike host", () => {
    expect(
      parsePostUrl("https://notfacebook.com.evil.io/groups/x/posts/1", R).storyId,
    ).toBeUndefined();
  });

  it("skips a pattern that does not compile instead of failing the whole parse", () => {
    const broken = { ...R, postUrlPatterns: ["([unclosed", ...(R.postUrlPatterns ?? [])] };
    expect(parsePostUrl("https://www.facebook.com/groups/1/posts/2/", broken).storyId).toBe("2");
  });
});

describe("reactionName", () => {
  it("maps the ids Facebook returns", () => {
    expect(reactionName("1635855486666999", R)).toBe("Like");
    expect(reactionName("1678524932434102", R)).toBe("Love");
    expect(reactionName("613557422527858", R)).toBe("Care");
  });

  it("keeps an unknown id as its number rather than guessing", () => {
    expect(reactionName("999999999999999", R)).toBe("999999999999999");
  });
});

describe("sightings", () => {
  const ctx = { postUrl: "https://fb/p/1", feedbackId: "555", groupId: "77", now: 1_700_000_000_000 };

  it("builds a reactor sighting with the mapped reaction", () => {
    const [r] = parseReactors(f["reactorsPage"]).items;
    const s = reactorSighting(r!, ctx, R);
    expect(s).toMatchObject({ source: "post.reactor", reaction: "Like", groupId: "77" });
    expect(s.commentId).toBeUndefined();
  });

  it("builds a commenter sighting carrying the text", () => {
    const [c] = parseComments(f["commentsFirstPage"]).items;
    const s = commentSighting(c!, ctx, R);
    expect(s.source).toBe("post.commenter");
    expect(s.text).toContain("0501234567");
    expect(s.commentId).toBeTruthy();
  });

  it("marks a sighting from our own post differently", () => {
    const [c] = parseComments(f["commentsFirstPage"]).items;
    expect(commentSighting(c!, { ...ctx, own: true }, R).source).toBe("own.commenter");
  });
});
