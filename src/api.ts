import { itemResource } from "./contract/resources.ts";
import { z } from "@hono/zod-openapi";
import { createResponseDraft } from "./item-create.ts";
import { contractApp, readJson, readForm } from "./contract/app.ts";
import { ItemCreateSchema, ItemEditSchema, routes } from "./contract/routes.ts";
// Owner API (cookie auth, JSON) — v0.1-plan §3.3.

import { type Context } from "hono";
import {
  authoredKind,
  createDraft,
  createFork,
  discardDraft,
  FragmentTooLongError,
  getItem,
  getMedia,
  getSettings,
  getVersion,
  insertMedia,
  pinVersion,
  publish,
  putSettings,
  RestoreVersionError,
  restoreVersion,
  TkPublishError,
  TransclusionResolveError,
  withdraw,
} from "./model.ts";
import { mentionFetch } from "./mentions/http.ts";
import { drainOutbound, enqueueForVersion } from "./mentions/send.ts";
import { checkForkTarget, resolveForkSource } from "./fork.ts";
import { flattenFork } from "./fork-flatten.ts";
import { blygItemUrl } from "./importer/util.ts";
import { siteOrigin } from "./protocol.ts";
import { parseForkedFrom, parseStoredFork, parseStoredStub, parseStubOf } from "./stub.ts";
import { runGenerateScope } from "./tk-generate.ts";
import type { Env, ItemRow, SubscriptionRow } from "./types.ts";
import { BLOCKING, staleThreads, threadFreshness } from "./freshness.ts";
import { draftChangeNote } from "./change-note.ts";
import { platformFetch } from "./importer/http.ts";
import { reconcileIndex } from "./importer/poll.ts";
import { isValidTimeZone, newMediaId, normalizeMount, nowIso } from "./util.ts";

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export const api = contractApp();

type ItemBody = z.infer<typeof ItemEditSchema>;

api.openapi(routes.createItem, async (c) => {
  const body = await readJson<z.infer<typeof ItemCreateSchema>>(c);
  if (body.mode === "fork") return createForkResponse(c, body.source);
  if (body.mode === "response") {
    const item = await createResponseDraft(c, { ...body.source, selection: body.selection });
    c.header("Location", `/api/items/${item.id}`);
    return c.json(itemResource(item), 201);
  }
  const kind = body.kind === "thread" ? "thread" : "fragment";
  // A stub is a thread declaring one target (§2.2) — the stub action creates
  // the draft and its citation in one call.
  let stub = null;
  if (body.stub_of != null) {
    if (kind !== "thread") return c.json({ error: "only threads can be stubs" }, 400);
    const parsed = parseStubOf(body.stub_of);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    stub = parsed.stub;
  }
  const item = await createDraft(c.env.DB, body.content_md ?? "", kind, stub);
  c.header("Location", `/api/items/${item.id}`);
  return c.json(itemResource(item), 201);
});

/**
 * The fork action (§2.4): start a new draft from a pinned version, own or
 * imported, and record the lineage permanently. One call does both because
 * they are one act — the content and the claim about where it came from must
 * not be separable, or a draft could be forked and then quietly disowned.
 *
 * Reading the *pinned file* rather than the live item is the point (see
 * fork.ts): a fork descends from bytes that are promised forever, so those are
 * the bytes it starts from.
 */
/** A quoted item's page for a flattened quote's attribution line: ours, an import's own `page`, else its item document. */
async function quotedLink(db: D1Database, quoteOrigin: string, id: string, ourOrigin: string): Promise<string> {
  if (quoteOrigin === ourOrigin) {
    const own = await db.prepare("SELECT kind FROM items WHERE id = ?").bind(id).first<{ kind: string }>();
    if (own) return blygItemUrl(ourOrigin, own.kind === "thread" ? "thread" : "fragment", id, null);
  }
  const row = await db
    .prepare("SELECT ii.kind AS kind, ii.page AS page FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ?")
    .bind(id, quoteOrigin)
    .first<{ kind: string; page: string | null }>();
  return row ? blygItemUrl(quoteOrigin, row.kind, id, row.page) : `${quoteOrigin}items/${id}.json`;
}

async function createForkResponse(c: Context<{ Bindings: Env }>, body: { origin: string; id: string; version: number }) {
  const parsed = parseForkedFrom(body);
  if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
  const settings = await getSettings(c.env.DB);
  const origin = siteOrigin(settings, c.req.url, normalizeMount(c.env.MOUNT));
  const resolved = await resolveForkSource(c.env.DB, parsed.ref, origin, settings.site_title, mentionFetch, nowIso());
  if (!resolved.ok) return c.json({ error: resolved.reason }, 400);
  // #57: the fork starts from the pinned document, flattened — baked quotes as
  // plain blockquotes with attribution, generated spans as impyrt.
  const flat = await flattenFork(resolved.source, { origin: parsed.ref.origin, link: (o, id) => quotedLink(c.env.DB, o, id, origin) });
  const item = await createFork(c.env.DB, flat.contentMd, resolved.source.kind, parsed.ref, resolved.source.cite);
  c.header("Location", `/api/items/${item.id}`);
  return c.json(itemResource(item), 201);
}

api.openapi(routes.updateItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<ItemBody>(c);
  const kind = body.kind ?? await authoredKind(c.env.DB, item);
  if (body.kind !== undefined && item.version !== 0) return c.json({ error: "kind is fixed once an item has been published" }, 409);
  const existingStub = parseStoredStub(item.stub_of);
  if (kind === "fragment" && body.stub_of != null) return c.json({ error: "only threads can be stubs" }, 400);
  if (body.kind === "fragment" && existingStub !== null && !("stub_of" in body && body.stub_of === null)) {
    return c.json({ error: "clear the stub before switching this to a fragment" }, 409);
  }
  let stubJson = item.stub_of;
  if ("stub_of" in body) {
    if (body.stub_of === null) stubJson = null;
    else {
      if (kind !== "thread") return c.json({ error: "only threads can be stubs" }, 400);
      const parsed = parseStubOf(body.stub_of);
      if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
      stubJson = JSON.stringify(parsed.stub);
    }
  }
  const changesDraft = body.content_md !== undefined || body.kind !== undefined || "stub_of" in body;
  const assignments: string[] = [], values: (string | number | null)[] = [];
  if (body.content_md !== undefined) { assignments.push("content_md = ?"); values.push(body.content_md); }
  if (body.kind !== undefined) { assignments.push("kind = ?"); values.push(body.kind); }
  if ("stub_of" in body) { assignments.push("stub_of = ?"); values.push(stubJson); }
  if (body.responses !== undefined) { assignments.push("responses_override = ?"); values.push(body.responses === "default" ? null : Number(body.responses === "show")); }
  if (changesDraft) { assignments.push("dirty = 1", "updated = CASE WHEN version = 0 THEN ? ELSE updated END"); values.push(nowIso()); }
  if (!assignments.length) return c.json(itemResource(item));
  // Write only requested fields. Guard the state used for validation, so a
  // concurrent publication or citation edit cannot invalidate that check.
  const fresh = await c.env.DB.prepare(`UPDATE items SET ${assignments.join(", ")} WHERE id = ? AND version = ? AND kind = ? AND stub_of IS ? RETURNING *`)
    .bind(...values, item.id, item.version, item.kind, item.stub_of).first<ItemRow>();
  if (!fresh) return c.json({ error: "item changed while applying the patch; reload and try again" }, 409);
  return c.json(itemResource(fresh));
});

/**
 * Queue (and immediately attempt) the mentions a version owes, then get out
 * of the way. Delivery is fire-and-forget from the author's point of view
 * (§2.3.3): publish has already succeeded by the time this runs, nothing here
 * can fail it, and the cron retries whatever this attempt doesn't land.
 */
async function sendMentionsFor(
  c: Context<{ Bindings: Env }>,
  itemId: string,
  version: number,
  opts: { force?: boolean } = {},
): Promise<void> {
  const row = await getVersion(c.env.DB, itemId, version);
  if (!row) return;
  const settings = await getSettings(c.env.DB);
  const origin = siteOrigin(settings, c.req.url, normalizeMount(c.env.MOUNT));
  const refs = await enqueueForVersion(c.env.DB, itemId, version, row, origin, opts);
  if (!refs.length) return;
  // Fire-and-forget in the strong sense: a delivery error is a row status,
  // never an uncaught rejection in the worker that just published.
  c.executionCtx.waitUntil(drainOutbound(c.env.DB, mentionFetch, { origin }).catch(() => {}));
}

/**
 * Publish an item and send what it owes — the one path both `publish` and
 * `refresh` take, so a refresh gets exactly a publish's checks and error
 * mapping. Returns the response to send.
 */
async function publishAndNotify(c: Context<{ Bindings: Env }>, item: ItemRow, note: string | null, extra: Record<string, unknown> = {}, noteGenerated = false) {
  const origin = siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));
  // §2.4's publish-time check. It lives here rather than inside publish()
  // deliberately: publish() is network-free by design (#26 — quoting follows
  // reading, and a publish must never depend on someone else's host being up),
  // and this is the one lineage claim that has to be re-tested against a
  // promise somebody else made. checkForkTarget only *fails* on evidence; an
  // unreachable origin is inconclusive and does not block the author.
  const fork = parseStoredFork(item.forked_from);
  let lineageNote: string | undefined;
  if (fork) {
    const check = await checkForkTarget(c.env.DB, fork, origin, mentionFetch);
    if (!check.ok) return c.json({ error: check.reason }, 400);
    lineageNote = check.skipped;
  }
  try {
    const version = await publish(c.env.DB, item, note, origin, noteGenerated);
    await sendMentionsFor(c, item.id, version);
    return c.json({ ok: true, version, ...extra, ...(lineageNote ? { warning: lineageNote } : {}) });
  } catch (e) {
    if (e instanceof TransclusionResolveError) {
      // Both bracket forms report here: `![[id]]` directives and `[[id]]`
      // links share the resolver, so they share the failure channel. The
      // message names both rather than only the one that predates the other —
      // each entry's `directive` shows the author which they wrote.
      return c.json({ error: "one or more references do not resolve", errors: e.errors }, 400);
    }
    if (e instanceof TkPublishError) {
      return c.json({ error: "one or more TK scopes are not publish-ready", errors: e.issues }, 400);
    }
    if (e instanceof FragmentTooLongError) {
      return c.json({ error: `fragment exceeds ${e.max} characters` }, 400);
    }
    throw e;
  }
}

api.openapi(routes.publishItem, async (c) => {
  // Also the republish path for withdrawn items: vN+1 restores 'public'/authored kind.
  // Studio-side fragment cap (§2.7) is enforced inside publish() against the
  // TK-stripped (published) length, not the raw working copy — see FragmentTooLongError.
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ note?: string; note_generated?: boolean }>(c);
  // note_generated is the studio's own assertion that the note is the drafted
  // text, unedited (#40) — self-asserted, like every provenance member.
  return publishAndNotify(c, item, body.note?.trim() || null, {}, body.note_generated === true);
});

/** Draft a changelog note from the local diff (#40). Never publishes; the author edits and decides. */
api.openapi(routes.draftNote, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const result = await draftChangeNote(c.env, item);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ note: result.note, model: result.model, pinned_prior: result.pinnedPrior });
});

// --- Snapshot freshness (decision #33's direct check; #38: detect always,
// refresh only on a decision, never silently) ---

api.openapi(routes.listStaleThreads, async (c) => c.json({ items: await staleThreads(c.env.DB) }));

api.openapi(routes.getItemFreshness, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.kind !== "thread" || item.status !== "public") return c.json({ error: "only a published thread has quoted snapshots" }, 409);
  const probe = c.req.query("probe") !== "false";
  return c.json(await threadFreshness(c.env.DB, item, probe ? platformFetch : undefined));
});

/**
 * Refresh a thread's stale quotes as one authoring act. A refresh **is** a
 * republish (#38): same working copy, new version, a feed entry, and mentions
 * to every origin whose target version changed (§15.2). So it refuses what a
 * republish of *other* words would be — unpublished edits in the working copy —
 * and what would fail anyway, and it refuses to bump a version for nothing.
 * Quotes whose origin is ahead of our import resync that subscription first;
 * the importer's own reconcile does the fetching, so a refreshed snapshot is
 * byte-for-byte what a scheduled poll would have stored.
 */
api.openapi(routes.refreshItem, async (c) => {
  const db = c.env.DB;
  let item = await getItem(db, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.kind !== "thread" || item.status !== "public") return c.json({ error: "only a published thread has quoted snapshots" }, 409);
  const body = await readJson<{ note?: string }>(c);
  let report = await threadFreshness(db, item, platformFetch);
  if (report.dirty) return c.json({ error: "this thread has unpublished edits; publish or discard them before refreshing its quotes" }, 409);
  let resynced = 0;
  const behind = new Set(report.quotes.filter((q) => q.status === "behind" && q.origin).map((q) => q.origin!));
  for (const origin of behind) {
    const sub = await db.prepare("SELECT * FROM subscriptions WHERE origin = ? AND kind = 'blyg'").bind(origin).first<SubscriptionRow>();
    if (!sub) continue;
    const result = await reconcileIndex(db, sub);
    if (result.ok) resynced++;
  }
  if (behind.size) report = await threadFreshness(db, item);
  const blocking = report.quotes.filter((q) => BLOCKING.has(q.status));
  if (blocking.length) {
    return c.json({ error: "a republish would fail: edit or remove these quotes first", errors: blocking.map((q) => ({ id: q.id, reason: q.reason ?? q.status })) }, 409);
  }
  const refreshed = report.quotes.filter((q) => q.status === "refreshable").map((q) => q.id);
  if (!refreshed.length) {
    return c.json({ error: behind.size ? "the newer versions could not be imported yet; try again after the next poll" : "every quote is already current" }, 409);
  }
  item = (await getItem(db, item.id))!;
  return publishAndNotify(c, item, body.note?.trim() || null, { refreshed, resynced });
});

/**
 * Quick post: one call creates a fragment and, with `publish: true`,
 * publishes it. Built for Drafts-style clients. It is the only /api route
 * that also accepts the scoped POST_TOKEN bearer (see index.ts), so the
 * token can add fragments to the blyg but can't edit, withdraw, or read
 * anything. A failed publish discards the new draft, so a rejected post
 * leaves nothing behind (the text is still in the client).
 */
api.post("/post", async (c) => {
  const body = await c.req.json<{ content_md?: unknown; publish?: unknown }>().catch(() => null);
  const text = typeof body?.content_md === "string" ? body.content_md.trim() : "";
  if (!text) return c.json({ error: "content_md required" }, 400);
  const item = await createDraft(c.env.DB, text, "fragment");
  const origin = siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));
  if (body?.publish !== true) {
    return c.json({ id: item.id, status: item.status }, 201);
  }
  let error: { error: string; errors?: unknown } | null = null;
  try {
    const version = await publish(c.env.DB, item, null, origin);
    await sendMentionsFor(c, item.id, version);
    return c.json({ id: item.id, status: "public", version, url: `${origin}f/${item.id}` }, 201);
  } catch (e) {
    if (e instanceof TransclusionResolveError) error = { error: "one or more transclusions do not resolve", errors: e.errors };
    else if (e instanceof TkPublishError) error = { error: "one or more TK scopes are not publish-ready", errors: e.issues };
    else if (e instanceof FragmentTooLongError) error = { error: `fragment exceeds ${e.max} characters` };
    else throw e;
  }
  await discardDraft(c.env.DB, item);
  return c.json(error, 400);
});

/**
 * TK generation (tk-core-plan.md §5): resolve scope `n`'s sources exactly
 * like transclusion targets, call the provider, splice the output into the
 * working copy, and record provenance for the next publish to pick up.
 * Errors are surfaced verbatim (no retry loop, per §5/§6 task 4). Logic
 * lives in tk-generate.ts's runGenerateScope so tests can inject a fixture
 * provider fetch (same DI pattern as importer/schedule.ts's runScheduledPoll).
 */
api.openapi(routes.generateItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ scope: number }>(c);

  const result = await runGenerateScope(c.env, item, body.scope);
  if (!result.ok) return c.json(result.body, result.status as 400 | 404 | 502);
  return c.json({ text: result.text, model: result.model });
});

api.openapi(routes.withdrawItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.status === "withdrawn") return c.json({ error: "already withdrawn" }, 409);
  if (item.status !== "public") return c.json({ error: "not published" }, 409);
  const body = await readJson<{ note?: string }>(c);
  const note = body.note?.trim() || null;
  const version = await withdraw(c.env.DB, item, note);
  // §2.3.6: a withdrawn stub re-sends its mention once, from the last real
  // version's references — the endcap has none — so the receiver re-verifies,
  // finds a withdrawn document, and marks the row gone. That is the
  // W3C-blessed way to say "this is no longer there".
  //
  // `force`, because §15.2's re-send test compares the *target's* version and a
  // withdrawal changes nothing about the target. This is the one notification
  // that must go out precisely when the reference has not changed, so it is the
  // one caller allowed to override the test (migration 0011).
  await sendMentionsFor(c, item.id, item.version, { force: true });
  return c.json({ ok: true, version });
});

api.openapi(routes.pinItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const version = Number(c.req.param("version"));
  const row = await getVersion(c.env.DB, item.id, version);
  if (!row) return c.json({ error: "version not found" }, 404);
  // Endcap (withdrawal) versions have no content to cite (§2.8).
  if (!row.content_md) return c.json({ error: "cannot pin an endcap version" }, 409);
  const already = row.pinned === 1;
  if (!already) await pinVersion(c.env.DB, item.id, version);
  return c.json({ ok: true, version: version, already });
});

/**
 * Restore a past version into the working copy (studio furniture). Nothing is
 * published here and no version number moves: the author reviews the restored
 * draft and publishes it as the next version, forward-only. See
 * model.restoreVersion().
 */
api.openapi(routes.restoreItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ version: number }>(c);
  try {
    await restoreVersion(c.env.DB, item, body.version);
  } catch (err) {
    if (err instanceof RestoreVersionError) return c.json({ error: err.message }, 409);
    throw err;
  }
  return c.json({ ok: true, restored: body.version, publishesAs: item.version + 1 });
});

api.openapi(routes.deleteItem, async (c) => {
  // Drafts only. Published items leave the public stream via withdraw — no delete exists.
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.version > 0) return c.json({ error: "published items are withdrawn, not deleted" }, 409);
  await discardDraft(c.env.DB, item);
  return c.json({ ok: true, outcome: "discarded" });
});

api.openapi(routes.uploadMedia, async (c) => {
  const form = await readForm(c).catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file field required (multipart)" }, 400);
  const ext = MEDIA_TYPES[file.type];
  if (!ext) return c.json({ error: `unsupported type ${file.type || "(none)"}; allowed: png/jpg/gif/webp/svg` }, 415);
  if (file.size > MEDIA_MAX_BYTES) return c.json({ error: "file exceeds 5 MB" }, 413);
  const itemId = form?.get("item_id");
  if (typeof itemId === "string" && itemId && !(await getItem(c.env.DB, itemId))) {
    return c.json({ error: "item_id not found" }, 404);
  }
  const id = newMediaId();
  const r2Key = `media/${id}.${ext}`;
  await c.env.MEDIA.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const alt = form?.get("alt");
  const row = await insertMedia(c.env.DB, {
    id,
    item_id: typeof itemId === "string" && itemId ? itemId : null,
    r2_key: r2Key,
    mime: file.type,
    alt: typeof alt === "string" ? alt : null,
    // The studio sends inline=true for an upload it places in the text
    // (studio#24): shown only where its line is, never appended.
    inline: form?.get("inline") === "true" ? 1 : 0,
  });
  c.header("Location", `/${normalizeMount(c.env.MOUNT).replace(/^\//, "")}/${row.r2_key}`.replace(/^\/\//, "/"));
  return c.json({ id: row.id, url: row.r2_key, mime: row.mime }, 201);
});

/**
 * Remove an attachment from its item (studio#24, #7). A media URL is a promise
 * to serve the same bytes (§5.4), so bytes any published version still shows
 * are kept and the row is only detached — it leaves the item, its page and its
 * `media` list. Bytes nothing published references are deleted outright.
 * The avatar is not an attachment and is refused.
 */
api.openapi(routes.deleteMedia, async (c) => {
  const db = c.env.DB;
  const row = await getMedia(db, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if ((await getSettings(db)).avatar_media_id === row.id) return c.json({ error: "this is the avatar; change it in Settings" }, 409);
  const published = await db.prepare("SELECT 1 FROM versions WHERE instr(content_html, ?) > 0 LIMIT 1").bind(row.r2_key).first();
  if (published) {
    await db.prepare("UPDATE media SET item_id = NULL WHERE id = ?").bind(row.id).run();
    return c.json({ ok: true, outcome: "detached" as const });
  }
  await c.env.MEDIA.delete(row.r2_key);
  await db.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return c.json({ ok: true, outcome: "deleted" as const });
});

const SETTINGS_KEYS = [
  "site_title",
  "theme",
  "author_name",
  "author_bio",
  "site_url",
  "avatar_media_id",
  "update_feed_url",
  "timezone",
  "ai_model_tk",
  "ai_model_changelog",
  "ai_model_feed",
  "feed_prompt",
  "ai_style_prompt",
] as const;

api.openapi(routes.updateSettings, async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const patch: Record<string, string> = {};
  // The pre-0.26 single model: sets the two functions it used to drive,
  // unless the same request names them itself.
  if (typeof body.ai_model === "string") {
    patch.ai_model_tk = body.ai_model;
    patch.ai_model_changelog = body.ai_model;
  }
  for (const key of SETTINGS_KEYS) {
    if (typeof body[key] === "string") patch[key] = body[key] as string;
  }
  for (const key of ["accept_mentions", "update_check", "show_responses_default", "auto_change_notes", "update_notice_ack"] as const) {
    if (typeof body[key] === "boolean") patch[key] = body[key] ? "on" : "off";
  }
  if (typeof patch.timezone === "string" && !isValidTimeZone(patch.timezone)) return c.json({ error: `unknown timezone: ${patch.timezone}` }, 400);
  if (Array.isArray(body.author_links)) patch.author_links = JSON.stringify(body.author_links);
  await putSettings(c.env.DB, patch);
  return c.json(await getSettings(c.env.DB));
});
