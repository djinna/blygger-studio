// Regression: a TK instruction asking for an image ("show a screenshot of…")
// made the model emit an invented transclusion ref, ![[7k2wq9fbz3mxdnp5rt8hyj4cve]],
// as its output. That was saved, published as literal "![[…]]" text, and then
// blocked every regenerate with "unresolvable source".
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderFetchLike } from "../src/ai/provider.ts";
import { createAndPublish, login } from "./helpers.ts";
import { createDraft, getItem, putSettings } from "../src/model.ts";
import { runGenerateScope } from "../src/tk-generate.ts";

const FAKE = "7k2wq9fbz3mxdnp5rt8hyj4cve";
function fixture(text: string): { fetchImpl: ProviderFetchLike; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    fetchImpl: async (_u, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: "m", content: [{ type: "text", text }] }) };
    },
  };
}

describe("TK generation never saves invented ![[id]] refs", () => {
  beforeEach(() => putSettings(env.DB, { ai_model: "claude-opus-5" }));
  it("rejects output containing an id that isn't a source, and saves nothing", async () => {
    const md = "[TK]show a screenshot of the previous screen[/TK]";
    const item = await createDraft(env.DB, md);
    const { fetchImpl } = fixture(`![[${FAKE}]]\n_context: this is what the screen looked like_`);
    const result = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, item, 0, fetchImpl);
    expect(result).toMatchObject({ ok: false, status: 502, body: { invented: [FAKE] } });
    expect((await getItem(env.DB, item.id))!.content_md).toBe(md);
  });

  it("still allows output that mentions one of the scope's real sources", async () => {
    const cookie = await login();
    const f1 = await createAndPublish(cookie, "real source");
    const item = await createDraft(env.DB, `[TK]summarize ![[${f1}]][/TK]`);
    const { fetchImpl } = fixture(`summary of ![[${f1}]]`);
    const result = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, item, 0, fetchImpl);
    expect(result).toMatchObject({ ok: true });
  });

  it("system prompt tells the model it is text-only and must not write ![[id]]", async () => {
    const item = await createDraft(env.DB, "[TK]anything[/TK]");
    const { fetchImpl, calls } = fixture("ok");
    await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, item, 0, fetchImpl);
    expect(calls[0].system).toMatch(/text only/);
    expect(calls[0].system).toContain("![[id]]");
  });


});
