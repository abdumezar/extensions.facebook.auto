// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { scrapeProfile } from "./domTokens.js";

/**
 * The profile scrape reads Facebook's inline bootstrap JSON. These fixtures are the
 * shapes that JSON actually takes — escaped Unicode for Arabic names, escaped slashes
 * in CDN URLs — because those escapes are exactly what a naive regex capture gets wrong.
 */

function setPage(html: string): void {
  document.documentElement.innerHTML = html;
}

function login(cUser: string): void {
  document.cookie = `c_user=${cUser}`;
}

function logout(): void {
  document.cookie = "c_user=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

beforeEach(() => {
  logout();
  setPage("<head></head><body></body>");
});

describe("scrapeProfile", () => {
  it("returns null when nobody is logged in", () => {
    setPage('<body><script>["CurrentUserInitialData",[],{"NAME":"Someone"}]</script></body>');
    expect(scrapeProfile()).toBeNull();
  });

  it("reads the name out of CurrentUserInitialData", () => {
    login("100001234567890");
    setPage(
      '<body><script>["CurrentUserInitialData",[],{"ACCOUNT_ID":"100001234567890","USER_ID":"100001234567890","NAME":"Layla Haddad","SHORT_NAME":"Layla"}]</script></body>',
    );

    expect(scrapeProfile()).toMatchObject({
      fbUserId: "100001234567890",
      name: "Layla Haddad",
    });
  });

  it("decodes an escaped Arabic name rather than returning the escape sequence", () => {
    login("555");
    // How Facebook actually serialises "ليلى" inside the inline bundle.
    setPage(
      '<body><script>["CurrentUserInitialData",[],{"USER_ID":"555","NAME":"\\u0644\\u064a\\u0644\\u0649"}]</script></body>',
    );

    expect(scrapeProfile()?.name).toBe("ليلى");
  });

  it("unescapes the slashes in a profile picture URL", () => {
    login("555");
    setPage(
      '<body><script>{"profile_picture":{"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/pic.jpg?oh=abc"}}</script></body>',
    );

    expect(scrapeProfile()?.avatarUrl).toBe("https://scontent.xx.fbcdn.net/v/pic.jpg?oh=abc");
  });

  it("builds a profile URL from the vanity name when there is one", () => {
    login("555");
    setPage('<body><script>{"userVanity":"layla.haddad"}</script></body>');

    expect(scrapeProfile()?.profileUrl).toBe("https://www.facebook.com/layla.haddad");
  });

  it("falls back to the numeric id when no vanity is present", () => {
    login("555");
    expect(scrapeProfile()?.profileUrl).toBe("https://www.facebook.com/555");
  });

  it("falls back to an avatar in the DOM when the bootstrap JSON has none", () => {
    login("555");
    setPage('<body><img src="https://scontent.xx.fbcdn.net/v/t39.30808-1/avatar.jpg" alt=""></body>');

    expect(scrapeProfile()?.avatarUrl).toContain("t39.30808-1");
  });

  it("still identifies the user when name and avatar are both unavailable", () => {
    login("555");
    const profile = scrapeProfile();

    expect(profile?.fbUserId).toBe("555");
    expect(profile?.name).toBeUndefined();
    expect(profile?.avatarUrl).toBeUndefined();
  });
});
