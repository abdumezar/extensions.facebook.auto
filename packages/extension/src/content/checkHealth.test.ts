// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { checkHealth } from "./domTokens.js";

/**
 * The probe that decides whether a Facebook hold may be lifted.
 *
 * Its failure mode is asymmetric and was shipped: matching against `innerHTML` meant
 * Facebook's own bundle — which names its checkpoint routes in inline script on nearly
 * every page — made every healthy session read as checkpointed. The user could never
 * satisfy "I've finished the check", because the answer was always "still blocked".
 * The first test below is that bug.
 */

function setPage(html: string): void {
  document.documentElement.innerHTML = html;
}

function login(): void {
  document.cookie = "c_user=100000000000001";
}

function at(url: string): void {
  window.history.replaceState({}, "", url);
}

beforeEach(() => {
  document.cookie = "c_user=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  setPage("<head></head><body></body>");
  at("/");
});

describe("checkHealth — the false positive that locked the app", () => {
  it("reports ok when only Facebook's own scripts mention a checkpoint", () => {
    login();
    setPage(`<head>
      <script type="application/json">{"routes":{"/checkpoint/1501000000000001/":{"a":1}}}</script>
      <script>requireLazy(["CheckpointRoute"],function(){});</script>
    </head><body><div>ملف شخصي</div><div>Groups</div></body>`);
    expect(checkHealth()).toBe("ok");
  });

  it("reports ok for a normal feed page", () => {
    login();
    setPage("<head></head><body><div>What's on your mind?</div></body>");
    expect(checkHealth()).toBe("ok");
  });
});

describe("checkHealth — real checkpoints", () => {
  it("sees a checkpoint from the url, which is the reliable signal", () => {
    login();
    at("/checkpoint/1501000000000001/");
    expect(checkHealth()).toBe("checkpoint");
  });

  it("sees a checkpoint rendered in place, from visible text", () => {
    login();
    setPage(
      "<head></head><body><h1>Facebook needs you to confirm it is you before this can continue.</h1></body>",
    );
    expect(checkHealth()).toBe("checkpoint");
  });

  it("sees the Arabic wording too", () => {
    login();
    setPage("<head></head><body><h1>يرجى تأكيد هويتك للمتابعة</h1></body>");
    expect(checkHealth()).toBe("checkpoint");
  });
});

describe("checkHealth — logged out", () => {
  it("reports logged_out with no c_user cookie, whatever the page says", () => {
    setPage("<head></head><body><div>anything</div></body>");
    expect(checkHealth()).toBe("logged_out");
  });

  it("reports logged_out on the login page", () => {
    login();
    at("/login/");
    expect(checkHealth()).toBe("logged_out");
  });

  it("does not mistake a group named 'login tips' for the login page", () => {
    login();
    at("/groups/logintips/");
    setPage("<head></head><body><div>Login tips group</div></body>");
    expect(checkHealth()).toBe("ok");
  });
});
