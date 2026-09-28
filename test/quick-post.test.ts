import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionSeconds, verifyPostToken } from "../src/auth.ts";
import type { Env } from "../src/types.ts";
import { apiJson, BASE, login } from "./helpers.ts";

const TOKEN = "test-post-token-0123456789abcdef0123456789";

function post(body: unknown, auth: string | null = `Bearer ${TOKEN}`, path = "/api/post") {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe("quick post (POST /api/post)", () => {
  it("publishes a fragment with the bearer token", async () => {
    const res = await post({ content_md: "hello from drafts", publish: true });
    expect(res.status).toBe(201);
    const j: any = await res.json();
    expect(j.status).toBe("public");
    expect(j.version).toBe(1);
    expect(j.url).toContain(`/f/${j.id}`);
    const item = await SELF.fetch(`${BASE}/blyg/items/${j.id}.json`);
    expect(item.status).toBe(200);
    expect(((await item.json()) as any).content_md).toBe("hello from drafts");
  });

  it("creates a studio draft (not public) without publish: true", async () => {
    const res = await post({ content_md: "just a draft" });
    expect(res.status).toBe(201);
    const j: any = await res.json();
    expect(j.status).toBe("draft");
    expect((await SELF.fetch(`${BASE}/blyg/items/${j.id}.json`)).status).toBe(404);
  });

  it("rejects missing or wrong tokens", async () => {
    expect((await post({ content_md: "x", publish: true }, null)).status).toBe(401);
    expect((await post({ content_md: "x", publish: true }, "Bearer nope")).status).toBe(401);
    expect((await post({ content_md: "x", publish: true }, TOKEN)).status).toBe(401);
  });

  it("the token opens no other /api route", async () => {
    expect((await post({ content_md: "x" }, `Bearer ${TOKEN}`, "/api/items")).status).toBe(401);
    const put = await SELF.fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(put.status).toBe(401);
  });

  it("still works with the owner cookie", async () => {
    const cookie = await login();
    const r = await apiJson(cookie, "POST", "/api/post", { content_md: "via cookie", publish: true });
    expect(r.status).toBe(201);
  });

  it("rejects empty text and over-cap fragments, leaving no draft behind", async () => {
    expect((await post({ content_md: "   ", publish: true })).status).toBe(400);
    const cookie = await login();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    const res = await post({ content_md: "a".repeat(1001), publish: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("exceeds");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    void cookie;
  });

  it("never matches when POST_TOKEN is unset or short", async () => {
    const base = env as unknown as Env;
    expect(await verifyPostToken({ ...base, POST_TOKEN: undefined }, "Bearer ")).toBe(false);
    expect(await verifyPostToken({ ...base, POST_TOKEN: "short" }, "Bearer short")).toBe(false);
  });
});

describe("SESSION_DAYS", () => {
  it("defaults to 30 days and honours a configured value", () => {
    const base = env as unknown as Env;
    expect(sessionSeconds({ ...base, SESSION_DAYS: undefined })).toBe(30 * 86400);
    expect(sessionSeconds({ ...base, SESSION_DAYS: "90" })).toBe(90 * 86400);
    expect(sessionSeconds({ ...base, SESSION_DAYS: "junk" })).toBe(30 * 86400);
  });
});
