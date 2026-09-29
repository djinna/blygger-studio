// Post to blyg — a Drafts action that sends the current draft to a Blygger
// reference-client blyg as a fragment, either published or as a studio draft.
// Paste into a single Script step. Make two actions ("Publish to blyg" and
// "Draft to blyg") with the same script; only `publish` differs.
// Both actions share one stored token (same credential name).

// ---- config ----
const CONFIG = Object.assign({
  site: "https://jd-blyg.exe.xyz",  // blyg origin (studio/api are host-rooted)
  publish: true,                    // true = publish now; false = save as studio draft
  maxChars: 1000,                   // server's fragment cap (FRAGMENT_MAX_CHARS)
}, typeof BLYG_CONFIG_OVERRIDE !== "undefined" ? BLYG_CONFIG_OVERRIDE : {});
// ---- end config ----

const TAG = CONFIG.publish ? "blyg-published" : "blyg-drafted";
const host = CONFIG.site.replace(/^https?:\/\//, "").replace(/\/+$/, "");

function fail(msg) {
  app.displayErrorMessage(msg);
  context.fail(msg);
}

function explain(status, body) {
  const detail = body && body.error ? `: ${body.error}` : "";
  switch (status) {
    case 400: return `blyg refused the post${detail}.`;
    case 401: return `Token rejected (401). Forget the "blyg ${host}" credential in Drafts › Settings › Credentials and re-run.`;
    case 0:   return `Couldn't reach ${host}.`;
    default:  return `blyg error ${status}${detail}. See the action log.`;
  }
}

function main() {
  const text = draft.content.trim();
  if (!text) return fail("Empty draft.");
  if (draft.hasTag("blyg-published")) return fail("Already published. Duplicate the draft to post again.");
  if (!CONFIG.publish && draft.hasTag("blyg-drafted")) return fail("Already sent as a studio draft.");
  if (text.length > CONFIG.maxChars) return fail(`${text.length} chars, over the ${CONFIG.maxChars} cap.`);

  const cred = Credential.create(`blyg ${host}`, `Quick-post token (POST_TOKEN) for ${host}.`);
  cred.addPasswordField("token", "Token");
  if (!cred.authorize()) return fail("No blyg token provided.");

  const resp = HTTP.create().request({
    url: `${CONFIG.site.replace(/\/+$/, "")}/api/post`,
    method: "POST",
    headers: { "Authorization": `Bearer ${cred.getValue("token")}` },
    data: { content_md: text, publish: CONFIG.publish },
  });

  let body = null;
  try { body = JSON.parse(resp.responseText); } catch (e) {}

  if (resp.success && body && body.id) {
    draft.addTag(TAG);
    draft.update();
    if (CONFIG.publish) {
      app.setClipboard(body.url);
      app.displaySuccessMessage("Published — link copied");
    } else {
      app.displaySuccessMessage("Saved as studio draft");
    }
  } else {
    console.log(`${resp.statusCode} ${resp.responseText}`);
    fail(explain(resp.statusCode, body));
  }
}

main();
