/**
 * dnrManager — installs the declarativeNetRequest rules that rewrite Origin/Referer
 * on the extension's POST XHRs to Facebook, so FB's CSRF/origin checks accept them.
 *
 * The rule initiator is bound to THIS extension via chrome.runtime.id at runtime (never a
 * hardcoded dev id), so it keeps working across dev and packed builds.
 */

const TARGET_DOMAINS = [
  "www.facebook.com",
  "upload.facebook.com",
  // Facebook's AJAX video-upload hosts (start/transfer/receive).
  "vupload2.facebook.com",
  "vupload-edge.facebook.com",
];

function buildRules(): chrome.declarativeNetRequest.Rule[] {
  const extId = chrome.runtime.id;
  return TARGET_DOMAINS.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: "origin",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: "https://www.facebook.com",
        },
        {
          header: "referer",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: `https://www.facebook.com/`,
        },
      ],
    },
    condition: {
      initiatorDomains: [extId],
      requestDomains: [domain],
      resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType],
      requestMethods: ["post" as chrome.declarativeNetRequest.RequestMethod],
    },
  }));
}

export async function installDnrRules(): Promise<void> {
  const rules = buildRules();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
  // eslint-disable-next-line no-console
  console.log("[nashir] DNR rules installed", { count: rules.length, ext: chrome.runtime.id });
}
