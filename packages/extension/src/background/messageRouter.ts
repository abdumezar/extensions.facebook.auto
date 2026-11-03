import {
  UiRequestSchema,
  CURRENT_SESSION,
  type UiRequest,
  type UiResponse,
  PRODUCT_NAME,
} from "@nashir/shared";
import { container } from "./container.js";
import { openOrFocusDashboard } from "./singleInstance.js";
import { FacebookClient } from "../engine/FacebookClient.js";
import { toCsv, toJson, toPhoneCsv } from "../engine/audienceExport.js";

/** Which of the usual causes a failed session bootstrap looks like, for the log. */
function bootstrapFailureReason(error: string): string {
  if (error.includes("(inject:")) return "Facebook tab cannot be scripted";
  if (error.includes("Not logged in")) return "logged out of Facebook";
  return "other";
}

/**
 * Routes typed UiRequests from the dashboard/popup to the engine. Returns a
 * uniform { ok, data?, error? } envelope. All handlers are async.
 */
export async function handleUiRequest(raw: unknown): Promise<UiResponse> {
  const parsed = UiRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid request: " + parsed.error.message };

  const c = container();
  const req: UiRequest = parsed.data;

  try {
    switch (req.type) {
      case "PING":
        return { ok: true, data: "pong" };

      case "GET_VERSION":
        return { ok: true, data: { name: PRODUCT_NAME, version: chrome.runtime.getManifest().version } };

      case "GET_DOC_IDS":
        return { ok: true, data: await c.docIds.list() };

      case "GET_UPDATE_STATE":
        return { ok: true, data: await c.updates.getState() };

      case "CHECK_FOR_UPDATE":
        return { ok: true, data: await c.updates.check({ manual: true }) };

      // ---- Live session ----
      case "GET_SESSION_STATUS":
        return { ok: true, data: await c.session.status() };

      case "BOOTSTRAP_SESSION": {
        // Free probe first. If a Facebook tab is already open we need nothing else.
        const quick = await c.session.status(false);
        if (!quick.loggedIn) return { ok: true, data: { session: quick, groups: [] } };

        if (quick.tokensReady) {
          const cache = await c.groupSync.syncIfStale();
          return { ok: true, data: { session: quick, groups: cache?.groups ?? [] } };
        }

        // A running campaign owns the call budget, and it also owns the shared tab.
        // Nothing here is worth interrupting a run for.
        const run = await c.engine.getState();
        if (run?.status === "running" || run?.status === "safety_break") {
          const cache = await c.groups.getCache(CURRENT_SESSION);
          return { ok: true, data: { session: quick, groups: cache.groups } };
        }

        // Only pay for a tab when there is something to learn. Once the name and the
        // group list are known, opening a background Facebook tab on every dashboard
        // open would be pure cost — the free paths (a tab the user opens, the alarm
        // loops) keep both fresh from then on.
        const cached = await c.groups.getCache(CURRENT_SESSION);
        if (quick.profile?.name && cached.groups.length > 0) {
          return { ok: true, data: { session: quick, groups: cached.groups } };
        }

        // Nothing is free and something is missing, so pay for it once: a background
        // tab, the profile and the groups, then put the tab back.
        try {
          const session = await c.session.status(true);
          const groups = await c.groupSync.load(CURRENT_SESSION, false);
          return { ok: true, data: { session, groups } };
        } catch (err) {
          // A failed bootstrap must still render a dashboard. Whatever is cached is
          // better than an error page.
          const cache = await c.groups.getCache(CURRENT_SESSION);
          const error = err instanceof Error ? err.message : String(err);
          c.logger.warn("Session bootstrap failed", { reason: bootstrapFailureReason(error), error });
          return { ok: true, data: { session: quick, groups: cache.groups } };
        } finally {
          await c.tab.releaseOwnedTab?.();
        }
      }

      // ---- Accounts ----
      case "LIST_ACCOUNTS":
        return { ok: true, data: await c.accounts.listAccounts() };

      case "ADD_ACCOUNT_FROM_SESSION": {
        const account = await c.accounts.addAccountFromSession();
        // The session we just captured is still the active one, so its profile is
        // readable without a swap. A failed scrape leaves a usable, if plainer, account.
        const profile = await c.session.profile(true).catch(() => null);
        const enriched = profile ? await c.accounts.applyProfile(account.id, profile) : null;
        return { ok: true, data: enriched ?? account };
      }

      case "REMOVE_ACCOUNT":
        await c.accounts.removeAccount(req.accountId);
        return { ok: true };

      case "CHECK_ACCOUNT_HEALTH": {
        const health = await c.accounts.withAccount(req.accountId, () => c.accounts.healthCheck());
        await c.accounts.updateAccount(req.accountId, { health });
        return { ok: true, data: { health } };
      }

      case "REFRESH_ACCOUNT_PROFILE": {
        // Needs that account's session live, so this one does swap cookies.
        const profile = await c.accounts.withAccount(req.accountId, async () => {
          const tabId = await c.tab.ensureFacebookTab();
          await c.tab.reloadAndWait(tabId);
          return c.session.profile(true);
        });
        if (!profile) return { ok: false, error: "Could not read the profile for this account." };
        return { ok: true, data: await c.accounts.applyProfile(req.accountId, profile) };
      }

      case "SET_ACCOUNT_LABEL": {
        const label = req.label.trim();
        if (!label) return { ok: false, error: "Label cannot be empty." };
        const updated = await c.accounts.updateAccount(req.accountId, { label });
        if (!updated) return { ok: false, error: "Account not found" };
        return { ok: true, data: updated };
      }

      // ---- Groups ----
      case "LOAD_GROUPS": {
        const groups = await c.groupSync.load(req.accountId, req.refresh ?? false);
        return { ok: true, data: groups };
      }

      case "GET_CACHED_GROUPS":
        return { ok: true, data: await c.groups.getCache(req.accountId) };

      case "SYNC_GROUPS_IF_STALE": {
        const cache = await c.groupSync.syncIfStale(req.accountId ?? CURRENT_SESSION);
        return { ok: true, data: cache };
      }

      case "PREVIEW_LEAVE_GROUP": {
        const recipe = await c.getRecipe();
        const preview = await withAccountTokens(c, req.accountId, (tokens) =>
          c.groupLeave.preview(req.groupId, tokens, recipe),
        );
        return { ok: true, data: preview };
      }

      case "LEAVE_GROUPS": {
        const recipe = await c.getRecipe();
        const results = await withAccountTokens(c, req.accountId, (tokens) =>
          c.groupLeave.leaveMany(req.accountId, req.groupIds, tokens, recipe, {
            spacingMs: req.spacingSeconds != null ? req.spacingSeconds * 1000 : undefined,
          }),
        );
        // A partial failure is still a result worth showing per group, so this stays ok.
        return { ok: true, data: results };
      }

      // ---- Phase-1 feasibility spike ----
      case "SPIKE_POST": {
        const recipe = await c.getRecipe();
        const doPost = async () => {
          const tokens = await c.scraper.scrapeCurrent();
          const fb = new FacebookClient(c.http, tokens, recipe, c.logger);
          return fb.createGroupPost({
            groupId: req.groupId,
            message: req.message,
            composerSessionId: `spike_${Date.now()}`,
          });
        };
        const result = req.accountId
          ? await c.accounts.withAccount(req.accountId, async () => {
              const tokens = await c.scraper.scrapeAfterSwap();
              const fb = new FacebookClient(c.http, tokens, recipe, c.logger);
              return fb.createGroupPost({
                groupId: req.groupId,
                message: req.message,
                composerSessionId: `spike_${Date.now()}`,
              });
            })
          : await doPost();
        return { ok: result.status !== "failed", data: result, error: result.error };
      }

      // ---- Campaign control ----
      case "START_CAMPAIGN": {
        const campaign = await c.storage.get<import("@nashir/shared").Campaign>(
          `nashir:campaign:${req.campaignId}`,
        );
        if (!campaign) return { ok: false, error: "Campaign not found" };
        const state = await c.engine.start(campaign);
        return { ok: true, data: state };
      }

      case "RUN_CAMPAIGN": {
        const campaign = req.campaign as import("@nashir/shared").Campaign;
        if (!campaign?.id || !Array.isArray(campaign.variations) || !Array.isArray(campaign.groupIds)) {
          return { ok: false, error: "Invalid campaign payload" };
        }
        await c.storage.set(`nashir:campaign:${campaign.id}`, campaign);
        const state = await c.engine.start(campaign);
        return { ok: true, data: state };
      }

      case "GET_RUN_RESULTS": {
        const st = await c.engine.getState();
        return { ok: true, data: st?.results ?? [] };
      }

      case "COUNT_FB_TABS": {
        const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
        return { ok: true, data: { count: tabs.length } };
      }

      case "PAUSE_RUN":
        await c.engine.pause();
        return { ok: true };

      case "RESUME_RUN":
        await c.engine.resume({ force: req.force === true });
        return { ok: true };

      case "GET_GOVERNOR_SNAPSHOT":
        return { ok: true, data: await c.governor.snapshot() };

      case "CLEAR_COOLDOWN":
        await c.governor.clearCooldown();
        return { ok: true };

      case "RESOLVE_CHECKPOINT": {
        // Deliberately NOT `accounts.healthCheck()`: that reloads the tab and bills the
        // governor for a `page.load`, which is refused during the very cooldown we are
        // trying to lift. Messaging the content script reads the page already on screen
        // and costs Facebook nothing.
        const tabId = await c.tab.findFacebookTab();
        if (tabId == null) {
          return { ok: true, data: { cleared: false, health: "unknown", needsTab: true } };
        }
        const res = await c.tab.callContent<{ health: string }>(tabId, { type: "CHECK_HEALTH" });
        const health = res.ok && res.data ? res.data.health : "unknown";
        if (health !== "ok") {
          return { ok: true, data: { cleared: false, health, needsTab: false } };
        }
        await c.governor.clearCooldown();
        c.logger.info("Checkpoint resolved by the operator", { health });
        return { ok: true, data: { cleared: true, health, needsTab: false } };
      }

      case "STOP_RUN":
        await c.engine.stop();
        return { ok: true };

      case "GET_RUN_SNAPSHOT":
        return { ok: true, data: await c.engine.getSnapshot() };

      // ---- Analytics ----
      case "GET_ANALYTICS": {
        const report = await c.analytics.report({
          accountId: req.accountId,
          campaignId: req.campaignId,
          range: req.range ?? "7d",
        });
        return { ok: true, data: report };
      }

      case "EXPORT_ANALYTICS": {
        const content =
          req.format === "csv" ? await c.analytics.exportCsv() : await c.analytics.exportJson();
        return { ok: true, data: { content, format: req.format } };
      }

      case "GET_LINK_PREVIEW": {
        // Needs a live page for tokens, but must never open one: the operator is typing
        // a caption, not asking us to touch Facebook. No tab, no preview, no harm.
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) {
          return {
            ok: true,
            data: {
              url: req.url,
              status: "failed",
              detail: "Open a Facebook tab to fetch link previews.",
              fetchedAt: Date.now(),
            },
          };
        }
        const recipe = await c.getRecipe();
        return { ok: true, data: await c.links.preview(req.url, tokens, recipe, req.refresh) };
      }

      // ---- Audience extraction ----
      case "RESOLVE_POST_URL":
        return { ok: true, data: await c.audience.resolvePost(req.postUrl, await c.getRecipe()) };

      case "START_EXTRACTION": {
        // Reads need a live session for tokens, but must never open a tab: the
        // operator asked for one post's audience, not for us to touch Facebook on
        // our own initiative. Same rule the link preview follows.
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) {
          return { ok: false, error: "Open a Facebook tab first — extraction reads your session." };
        }
        const recipe = await c.getRecipe();
        // Deliberately not awaited. The walk runs for minutes and survives the tab
        // closing; the page polls GET_EXTRACTION_STATE. Awaiting here would make a
        // closed dashboard strand the run — the mistake the feasibility ramp exists
        // to demonstrate the fix for.
        void c.audience
          .extract(req.postUrl, tokens, recipe, {
            ...(req.defaultRegion ? { defaultRegion: req.defaultRegion as never } : {}),
            ...(req.skipReactors !== undefined ? { skipReactors: req.skipReactors } : {}),
            ...(req.skipComments !== undefined ? { skipComments: req.skipComments } : {}),
          })
          .catch((err) => c.logger.error("Extraction failed", { error: String(err) }));
        return { ok: true, data: await c.audience.state() };
      }

      case "GET_EXTRACTION_STATE":
        return { ok: true, data: await c.audience.state() };

      case "ABORT_EXTRACTION":
        c.audience.abort();
        return { ok: true };

      case "QUERY_AUDIENCE":
        return {
          ok: true,
          data: await c.audienceStore.query({
            ...(req.search !== undefined ? { search: req.search } : {}),
            ...(req.source !== undefined ? { source: req.source } : {}),
            ...(req.postUrl !== undefined ? { postUrl: req.postUrl } : {}),
            ...(req.withContactOnly !== undefined ? { withContactOnly: req.withContactOnly } : {}),
            ...(req.minConfidence !== undefined ? { minConfidence: req.minConfidence } : {}),
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
            ...(req.offset !== undefined ? { offset: req.offset } : {}),
            excludeSuppressed: req.excludeSuppressed ?? false,
          }),
        };

      case "EXPORT_AUDIENCE": {
        // An export is the thing that actually reaches people, so the do-not-contact
        // list is applied here rather than trusted to the caller.
        const page = await c.audienceStore.query({
          excludeSuppressed: true,
          ...(req.withContactOnly !== undefined ? { withContactOnly: req.withContactOnly } : {}),
          ...(req.minConfidence !== undefined ? { minConfidence: req.minConfidence } : {}),
        });
        const content =
          req.format === "json"
            ? toJson(page.rows)
            : req.withContactOnly
              ? toPhoneCsv(page.rows)
              : toCsv(page.rows);
        return { ok: true, data: { content, format: req.format, rows: page.total } };
      }

      case "SUPPRESS_CONTACT":
        await c.audienceStore.suppress({
          id: req.id,
          reason: req.reason,
          at: Date.now(),
          ...(req.note ? { note: req.note } : {}),
        });
        return { ok: true };

      case "UNSUPPRESS_CONTACT":
        await c.audienceStore.unsuppress(req.id);
        return { ok: true };

      case "LIST_SUPPRESSIONS":
        return { ok: true, data: await c.audienceStore.suppressions() };

      case "CLEAR_AUDIENCE": {
        await c.audienceStore.clear();
        // The suppression list is cleared only when asked for explicitly. A
        // do-not-contact record must outlive the data it was about, or wiping the
        // table silently re-permits everyone the operator had already excluded.
        if (req.includeSuppression) await c.audienceStore.clearSuppression();
        return { ok: true };
      }

      case "CONFIGURE_ENGAGEMENT":
        return {
          ok: true,
          data: await c.engagement.configure({
            ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
            ...(req.defaultRegion ? { defaultRegion: req.defaultRegion as never } : {}),
          }),
        };

      case "GET_ENGAGEMENT": {
        const state = await c.engagement.getState();
        return { ok: true, data: { ...state.config, due: (await c.engagement.due(Date.now())).length } };
      }

      // ---- Lead Radar ----
      case "GET_RADAR": {
        const state = await c.radar.getState();
        return {
          ok: true,
          data: {
            config: state.config,
            matches: state.matches,
            lastSweepAt: state.lastSweepAt ?? null,
            unsupported: state.unsupported ?? false,
            supported: Boolean((await c.getRecipe()).groupFeed?.docId),
          },
        };
      }

      case "CONFIGURE_RADAR":
        return {
          ok: true,
          data: await c.radar.configure({
            ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
            ...(req.notify !== undefined ? { notify: req.notify } : {}),
            ...(req.lang !== undefined ? { lang: req.lang } : {}),
            ...(req.defaultRegion ? { defaultRegion: req.defaultRegion as never } : {}),
            ...(req.watchedGroupIds ? { watchedGroupIds: req.watchedGroupIds } : {}),
            ...(req.rules ? { rules: req.rules } : {}),
          }),
        };

      case "MARK_LEAD_HANDLED":
        await c.radar.markHandled(req.id);
        return { ok: true };

      case "CLEAR_LEADS":
        await c.radar.clearMatches();
        return { ok: true };

      // ---- Comments ----
      case "POST_COMMENT": {
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) return { ok: false, error: "Open a Facebook tab first." };
        return { ok: true, data: await c.comments.comment(req.postUrl, req.body, tokens, await c.getRecipe()) };
      }

      // ---- Group discovery and joining ----
      case "SEARCH_GROUPS": {
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) return { ok: false, error: "Open a Facebook tab first." };
        return { ok: true, data: await c.joins.search(req.keyword, tokens, await c.getRecipe()) };
      }

      case "JOIN_GROUPS": {
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) return { ok: false, error: "Open a Facebook tab first." };
        return { ok: true, data: await c.joins.join(req.groupIds, tokens, await c.getRecipe()) };
      }

      case "GET_JOIN_BUDGET":
        return {
          ok: true,
          data: {
            remaining: await c.joins.remainingToday(),
            supported: c.joins.joinSupported(await c.getRecipe()),
            searchSupported: c.joins.searchSupported(await c.getRecipe()),
          },
        };

      // ---- Rosters ----
      case "EXTRACT_ROSTER": {
        const tokens = await c.scraper.scrapeFromOpenTab();
        if (!tokens) return { ok: false, error: "Open a Facebook tab first." };
        const recipe = await c.getRecipe();
        void c.audience
          .extractRoster(req.kind, req.targetId, tokens, recipe)
          .catch((err) => c.logger.error("Roster extraction failed", { error: String(err) }));
        return { ok: true, data: await c.audience.state() };
      }

      // ---- Phase-1 feasibility gate ----
      case "GET_FEASIBILITY":
        return { ok: true, data: await c.feasibility.get() };

      case "RUN_FEASIBILITY_CHECK": {
        const check = await c.feasibility.runCheck({
          checkId: req.checkId,
          groupId: req.groupId,
          message: req.message,
          accountIdA: req.accountIdA,
          accountIdB: req.accountIdB,
        });
        // A failed check is still a completed request — the verdict IS the payload.
        return { ok: true, data: check };
      }

      case "START_RATE_RAMP": {
        const state = await c.feasibility.startRamp({
          accountId: req.accountId,
          groupIds: req.groupIds,
          message: req.message,
          tiers: req.tiers,
          cap: req.cap,
        });
        return { ok: true, data: state };
      }

      case "ABORT_RATE_RAMP":
        return { ok: true, data: await c.feasibility.abortRamp() };

      case "CLEAR_FEASIBILITY":
        return { ok: true, data: await c.feasibility.clear() };

      case "CLEAR_ANALYTICS":
        await c.analytics.clear();
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run `fn` with live session tokens for `accountId`.
 *
 * For the browser's own login that is just a scrape; for a managed account it means
 * swapping cookies first, which is why every such call has to be wrapped rather than
 * scraping directly — `withAccount` is what puts the cookies back afterwards.
 */
async function withAccountTokens<T>(
  c: ReturnType<typeof container>,
  accountId: string,
  fn: (tokens: import("@nashir/shared").SessionTokens) => Promise<T>,
): Promise<T> {
  if (accountId === CURRENT_SESSION) return fn(await c.scraper.scrapeCurrent());
  return c.accounts.withAccount(accountId, async () => fn(await c.scraper.scrapeAfterSwap()));
}

export { openOrFocusDashboard };
