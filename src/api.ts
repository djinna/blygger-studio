// Owner API (cookie auth, JSON) — v0.1-plan §3.3.

import { type Context, Hono } from "hono";
import {
  authoredKind,
  createDraft,
  createFork,
  discardDraft,
  FragmentTooLongError,
  getItem,
  getSettings,
  getVersion,
  insertMedia,
  pinVersion,
  publish,
  putSettings,
  RestoreVersionError,
  restoreVersion,
  saveWorkingCopy,
  setDraftKind,
  setStubOf,
  TkPublishError,
  TransclusionResolveError,
  withdraw,
} from "./model.ts";
import { mentionFetch } from "./mentions/http.ts";
import { drainOutbound, enqueueForVersion } from "./mentions/send.ts";
import { checkForkTarget, resolveForkSource } from "./fork.ts";
import { siteOrigin } from "./protocol.ts";
import { parseForkedFrom, parseStoredFork, parseStoredStub, parseStubOf } from "./stub.ts";
import { runGenerateScope } from "./tk-generate.ts";
import type { Env } from "./types.ts";
import { isValidTimeZone, newMediaId, normalizeMount, nowIso } from "./util.ts";

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export const api = new Hono<{ Bindings: Env }>({ strict: false });

type ItemBody = { content_md?: string; kind?: string; stub_of?: unknown };

api.post("/items", async (c) => {
  const body = await c.req.json<ItemBody>().catch(() => ({}) as ItemBody);
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
  const item = await createDraft(c.env.DB, body.content_md ?? "", kind);
  if (stub) await setStubOf(c.env.DB, item.id, stub);
  return c.json({ id: item.id, kind: item.kind, status: item.status }, 201);
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
api.post("/fork", async (c) => {
  const body = await c.req.json<{ origin?: unknown; id?: unknown; version?: unknown }>().catch(() => ({}));
  const parsed = parseForkedFrom(body);
  if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
  const settings = await getSettings(c.env.DB);
  const origin = siteOrigin(settings, c.req.url, normalizeMount(c.env.MOUNT));
  const resolved = await resolveForkSource(c.env.DB, parsed.ref, origin, settings.site_title, mentionFetch, nowIso());
  if (!resolved.ok) return c.json({ error: resolved.reason }, 400);
  const item = await createFork(c.env.DB, resolved.source.contentMd, resolved.source.kind, parsed.ref, resolved.source.cite);
  return c.json({ id: item.id, kind: item.kind, status: item.status }, 201);
});

api.put("/items/:id", async (c) => {
  // Withdrawn items stay editable — the working copy survives withdrawal
  // and can be republished (§3.1).
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<ItemBody>();
  // `kind` on a **never-published** draft only (session 28). A draft has no
  // wire presence — no item document, no feed entry, nothing anyone has
  // fetched — so its kind is still studio state and switching it rewrites
  // nothing. The moment it is published, `kind` is a field readers have and
  // history records, and changing it would make the archive disagree with
  // itself; a withdrawn item is *published* by this test, because its
  // endcap and its versions are both out there.
  //
  // The composer's own toggle does not come through here: it deletes and
  // recreates, which it can because the text lives in its textarea. An
  // editor draft has attachments, TK scopes and a save history behind it, so
  // it is changed in place instead.
  if (body.kind !== undefined) {
    const kind = body.kind === "thread" ? "thread" : "fragment";
    if (item.version !== 0) {
      return c.json({ error: "kind is fixed once an item has been published" }, 409);
    }
    // Only threads carry a citation (§2.2), and a stub is a deliberate act —
    // dropping it silently on a kind switch would discard a claim the author
    // made. "clear stub" is already in the editor, so ask for it.
    if (kind === "fragment" && parseStoredStub(item.stub_of)) {
      return c.json({ error: "clear the stub before switching this to a fragment" }, 409);
    }
    if (kind !== item.kind) await setDraftKind(c.env.DB, item.id, kind);
    if (typeof body.content_md !== "string" && !("stub_of" in body)) return c.json({ ok: true, kind });
  }
  // `stub_of: null` clears the citation — the body stays as written, so what
  // was a stub becomes a thread that happens to quote something (§3.1).
  if ("stub_of" in body) {
    if ((await authoredKind(c.env.DB, item)) !== "thread") return c.json({ error: "only threads can be stubs" }, 400);
    if (body.stub_of === null) {
      await setStubOf(c.env.DB, item.id, null);
    } else {
      const parsed = parseStubOf(body.stub_of);
      if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
      await setStubOf(c.env.DB, item.id, parsed.stub);
    }
    if (typeof body.content_md !== "string") return c.json({ ok: true });
  }
  if (typeof body.content_md !== "string") return c.json({ error: "content_md required" }, 400);
  await saveWorkingCopy(c.env.DB, item.id, body.content_md);
  return c.json({ ok: true });
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

api.post("/items/:id/publish", async (c) => {
  // Also the republish path for withdrawn items: vN+1 restores 'public'/authored kind.
  // Studio-side fragment cap (§2.7) is enforced inside publish() against the
  // TK-stripped (published) length, not the raw working copy — see FragmentTooLongError.
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
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
    const version = await publish(c.env.DB, item, note, origin);
    await sendMentionsFor(c, item.id, version);
    return c.json({ ok: true, version, ...(lineageNote ? { warning: lineageNote } : {}) });
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
api.post("/items/:id/generate", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ scope?: number }>().catch(() => ({}) as { scope?: number });
  if (typeof body.scope !== "number") return c.json({ error: "scope index required" }, 400);

  const result = await runGenerateScope(c.env, item, body.scope);
  if (!result.ok) return c.json(result.body, result.status as 400 | 404 | 502);
  return c.json({ text: result.text, model: result.model });
});

api.post("/items/:id/withdraw", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.status === "withdrawn") return c.json({ error: "already withdrawn" }, 409);
  if (item.status !== "public") return c.json({ error: "not published" }, 409);
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
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

api.post("/items/:id/pin", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number });
  if (typeof body.version !== "number") return c.json({ error: "version required" }, 400);
  const row = await getVersion(c.env.DB, item.id, body.version);
  if (!row) return c.json({ error: "version not found" }, 404);
  // Endcap (withdrawal) versions have no content to cite (§2.8).
  if (!row.content_md) return c.json({ error: "cannot pin an endcap version" }, 409);
  const already = row.pinned === 1;
  if (!already) await pinVersion(c.env.DB, item.id, body.version);
  return c.json({ ok: true, version: body.version, already });
});

/**
 * Restore a past version into the working copy (studio furniture). Nothing is
 * published here and no version number moves: the author reviews the restored
 * draft and publishes it as the next version, forward-only. See
 * model.restoreVersion().
 */
api.post("/items/:id/restore", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number });
  if (typeof body.version !== "number") return c.json({ error: "version required" }, 400);
  try {
    await restoreVersion(c.env.DB, item, body.version);
  } catch (err) {
    if (err instanceof RestoreVersionError) return c.json({ error: err.message }, 409);
    throw err;
  }
  return c.json({ ok: true, restored: body.version, publishesAs: item.version + 1 });
});

api.delete("/items/:id", async (c) => {
  // Drafts only. Published items leave the public stream via withdraw — no delete exists.
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.version > 0) return c.json({ error: "published items are withdrawn, not deleted" }, 409);
  await discardDraft(c.env.DB, item);
  return c.json({ ok: true, outcome: "discarded" });
});

api.post("/media", async (c) => {
  const form = await c.req.formData().catch(() => null);
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
  });
  return c.json({ id: row.id, url: row.r2_key, mime: row.mime }, 201);
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
  "ai_model",
  "ai_style_prompt",
] as const;

api.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "JSON body required" }, 400);
  const patch: Record<string, string> = {};
  for (const key of SETTINGS_KEYS) {
    if (typeof body[key] === "string") patch[key] = body[key] as string;
  }
  // Two-valued, and validated rather than coerced: `getSettings` treats
  // anything but "off" as on, so accepting a free string here would let a typo
  // silently re-open the endpoint the operator meant to close.
  if (typeof body.accept_mentions === "boolean") {
    patch.accept_mentions = body.accept_mentions ? "on" : "off";
  } else if (body.accept_mentions === "on" || body.accept_mentions === "off") {
    patch.accept_mentions = body.accept_mentions;
  } else if (body.accept_mentions !== undefined) {
    return c.json({ error: "accept_mentions must be a boolean, or \"on\" / \"off\"" }, 400);
  }
  // Same two-valued validation as accept_mentions, and for a sharper reason:
  // `getSettings` treats anything but "on" as off, so a typo here fails closed
  // (no check) rather than open. Still validated — silently ignoring a
  // misspelled value would leave an operator believing they had enabled it.
  if (typeof body.update_check === "boolean") {
    patch.update_check = body.update_check ? "on" : "off";
  } else if (body.update_check === "on" || body.update_check === "off") {
    patch.update_check = body.update_check;
  } else if (body.update_check !== undefined) {
    return c.json({ error: "update_check must be a boolean, or \"on\" / \"off\"" }, 400);
  }
  // Validated rather than trusted: a bad zone would otherwise be written once
  // and then silently swallowed by formatDateIn's UTC fallback on every page,
  // leaving the author with a setting that looks saved and does nothing.
  if (typeof patch.timezone === "string" && !isValidTimeZone(patch.timezone)) {
    return c.json({ error: `unknown timezone: ${patch.timezone}` }, 400);
  }
  if (typeof body.show_responses_default === "boolean") {
    patch.show_responses_default = body.show_responses_default ? "on" : "off";
  } else if (body.show_responses_default === "on" || body.show_responses_default === "off") {
    patch.show_responses_default = body.show_responses_default;
  } else if (body.show_responses_default !== undefined) {
    return c.json({ error: 'show_responses_default must be a boolean, or "on" / "off"' }, 400);
  }
  if (body.update_notice_ack === true || body.update_notice_ack === "on") {
    patch.update_notice_ack = "on";
  }
  if (Array.isArray(body.author_links)) {
    const links = body.author_links.filter(
      (l): l is { label: string; url: string } =>
        !!l && typeof l === "object" && typeof (l as Record<string, unknown>).label === "string" && typeof (l as Record<string, unknown>).url === "string",
    );
    patch.author_links = JSON.stringify(links.map((l) => ({ label: l.label, url: l.url })));
  }
  await putSettings(c.env.DB, patch);
  return c.json({ ok: true });
});
