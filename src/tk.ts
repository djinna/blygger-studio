// TK (instructed generation) authoring grammar — tk-core-plan.md §2, decision #20
// (grammar respelled to balanced tokens §9, session 16). Studio-private: this
// grammar never reaches the wire. Publish strips every scope to its bare
// output (see stripToOutput); the wire never sees "[TK]".

import { renderMarkdown } from "./markdown.ts";
import { ID_ALPHABET } from "./identity.ts";
import { codeRanges, inRanges } from "./code-ranges.ts";

const SOURCE_REF = new RegExp(`!\\[\\[([${ID_ALPHABET}]{26})\\]\\]`, "g");

export interface TkScope {
  /** Index of the opening "[TK]" token in the source string. */
  start: number;
  /** Index just after the closing "[/TK]" token. */
  end: number;
  instruction: string;
  /** Text between "[=]" and "[/TK]"; null when the scope has not been generated yet. */
  output: string | null;
  /** Deduplicated `![[id]]` refs found anywhere in the scope (instruction or output), first-occurrence order. */
  sourceIds: string[];
  /** Index in the source string right after "[=]", i.e. where `output` begins; null when the scope has no "[=]" yet. */
  outputStart: number | null;
  /**
   * True when the scope occupies a paragraph by itself (preceded and
   * followed only by a blank line or a document edge) — renders as a
   * `<div class="blyg-tk-gen">`. False renders as an inline `<span>`.
   */
  block: boolean;
  /**
   * Set for an `impyrt` scope (decision #37, spec §5.7 rule 7): text generated
   * elsewhere and pasted in, disclosed like any generated span. Its provenance
   * is in the grammar — `sources: []`, and `model` only when the author wrote
   * one — so it never needs the positional provenance cache and survives any
   * edit that reorders scopes. Never regenerated.
   */
  imported?: { model?: string };
}

/**
 * `[TK]impyrt=<pasted text>[/TK]`, or `[TK]impyrt <model>=<pasted text>[/TK]`
 * when the author knows what produced it. The first `=` ends the keyword, so the
 * pasted text may contain `=` freely. `[TK]impyrt[=]…[/TK]` and
 * `[TK]impyrt <model>[=]…[/TK]` mean the same, since "impyrt" is not an
 * instruction anyone would hand a model.
 */
const IMPYRT_INLINE = /^\s*impyrt(?:[ \t]+([^\s=]+))?[ \t]*=/i;
const IMPYRT_INSTRUCTION = /^impyrt(?:[ \t]+(\S+))?$/i;

export interface TkParseError {
  at: number;
  reason: string;
}

export function extractSourceIds(scopeText: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of scopeText.matchAll(SOURCE_REF)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

const BLANK_BEFORE = /(^|\n[ \t]*\n)[ \t]*$/;
const BLANK_AFTER = /^[ \t]*(\n[ \t]*\n|$)/;

function isBlockPosition(contentMd: string, start: number, end: number): boolean {
  return BLANK_BEFORE.test(contentMd.slice(0, start)) && BLANK_AFTER.test(contentMd.slice(end));
}

/**
 * Linear token scan for `[TK]<instruction>[=]<output>[/TK]` — no bracket
 * balancing, matching tk-core-plan.md §2.1: the scanner only looks for the
 * three literal tokens, so `![[id]]` refs are safe to write inside an
 * instruction or output. No nesting: a second "[TK]" found before the
 * enclosing scope's "[/TK]" is a parse error and the outer scope is skipped
 * (scanning resumes after its close) rather than partially recovered.
 */
export function parseScopes(contentMd: string): { scopes: TkScope[]; errors: TkParseError[] } {
  const scopes: TkScope[] = [];
  const errors: TkParseError[] = [];
  // A `[TK]` written inside code is an example of the grammar, not a scope
  // (studio#3), the same exemption the bracket grammar has (§10.1, #54).
  const code = contentMd.includes("[TK]") ? codeRanges(contentMd) : [];
  let i = 0;
  while (true) {
    const tkIdx = contentMd.indexOf("[TK]", i);
    if (tkIdx === -1) break;
    if (inRanges(code, tkIdx)) {
      i = tkIdx + 4;
      continue;
    }
    const closeIdx = contentMd.indexOf("[/TK]", tkIdx + 4);
    if (closeIdx === -1) {
      errors.push({ at: tkIdx, reason: "unterminated scope (missing [/TK])" });
      break;
    }
    const nestedIdx = contentMd.indexOf("[TK]", tkIdx + 4);
    if (nestedIdx !== -1 && nestedIdx < closeIdx) {
      errors.push({ at: nestedIdx, reason: "nested TK scopes are not supported" });
      i = closeIdx + 5;
      continue;
    }
    const eqIdx = contentMd.indexOf("[=]", tkIdx + 4);
    const hasEq = eqIdx !== -1 && eqIdx < closeIdx;
    const instrEnd = hasEq ? eqIdx : closeIdx;
    let instruction = contentMd.slice(tkIdx + 4, instrEnd).trim();
    let output = hasEq ? contentMd.slice(eqIdx + 3, closeIdx) : null;
    let outputStart = hasEq ? eqIdx + 3 : null;
    let imported: TkScope["imported"];
    const inline = hasEq ? null : IMPYRT_INLINE.exec(contentMd.slice(tkIdx + 4, closeIdx));
    const keyword = hasEq ? IMPYRT_INSTRUCTION.exec(instruction) : null;
    if (inline) {
      outputStart = tkIdx + 4 + inline[0].length;
      output = contentMd.slice(outputStart, closeIdx);
      instruction = "impyrt";
      imported = inline[1] ? { model: inline[1] } : {};
    } else if (keyword) {
      instruction = "impyrt";
      imported = keyword[1] ? { model: keyword[1] } : {};
    }
    const end = closeIdx + 5;
    scopes.push({
      start: tkIdx,
      end,
      instruction,
      output,
      sourceIds: imported ? [] : extractSourceIds(contentMd.slice(tkIdx, end)),
      outputStart,
      block: isBlockPosition(contentMd, tkIdx, end),
      ...(imported ? { imported } : {}),
    });
    i = end;
  }
  return { scopes, errors };
}

/**
 * Wrap a selection as `[TK]impyrt=…[/TK]` (decision #37): text generated by
 * another tool and pasted in, disclosed as generated with no sources declared.
 * No model is filled in — the author may add one as `[TK]impyrt <model>=…`,
 * but the studio must not invent it.
 */
export function markImported(text: string, start: number, end: number) {
  return `${text.slice(0, start)}[TK]impyrt=${text.slice(start, end)}[/TK]${text.slice(end)}`;
}

/** Scopes with no output yet — publishing with any of these present is a publish error (§2.4). */
export function unresolvedScopes(scopes: TkScope[]): TkScope[] {
  return scopes.filter((s) => s.output === null);
}

export interface TkPublishIssue {
  at: number;
  reason: string;
}

/** Thrown by model.publish() when the working copy isn't publish-ready: malformed grammar or an unresolved scope. */
export class TkPublishError extends Error {
  constructor(public readonly issues: TkPublishIssue[]) {
    super("TK scopes are not publish-ready");
  }
}

export interface GeneratedSpan {
  /** Offset of the output text within the *stripped* string returned alongside this span. */
  start: number;
  end: number;
  block: boolean;
  sourceIds: string[];
}

/**
 * Strip every scope down to its bare output (`[TK]…[=]` and `[/TK]`
 * removed, output text kept in place) — the wire `content_md` transform of
 * §2.4. Every scope MUST have output; check via unresolvedScopes() first.
 * Returns the generated-text spans' offsets in the *stripped* string, for
 * HTML disclosure wrapping at render time.
 */
export function stripToOutput(contentMd: string, scopes: TkScope[]): { text: string; spans: GeneratedSpan[] } {
  let out = "";
  let last = 0;
  const spans: GeneratedSpan[] = [];
  for (const s of scopes) {
    if (s.output === null) {
      throw new Error("stripToOutput: scope has no output — call unresolvedScopes() first");
    }
    out += contentMd.slice(last, s.start);
    const spanStart = out.length;
    out += s.output;
    spans.push({ start: spanStart, end: spanStart + s.output.length, block: s.block, sourceIds: s.sourceIds });
    last = s.end;
  }
  out += contentMd.slice(last);
  return { text: out, spans };
}

/**
 * Studio-preview variant of stripToOutput — never throws. An ungenerated
 * scope substitutes a visible placeholder instead of aborting, so the studio
 * preview (task 6) can show authors what publish will reject before they hit
 * publish, matching previewTransclusions's pattern for bad `![[id]]` refs.
 */
export function previewStrip(contentMd: string, scopes: TkScope[]): { text: string; spans: GeneratedSpan[] } {
  let out = "";
  let last = 0;
  const spans: GeneratedSpan[] = [];
  for (const s of scopes) {
    out += contentMd.slice(last, s.start);
    const spanStart = out.length;
    const text = s.output !== null ? s.output : `⚠ ungenerated — ${s.instruction || "(no instruction)"}`;
    out += text;
    spans.push({ start: spanStart, end: spanStart + text.length, block: s.block, sourceIds: s.sourceIds });
    last = s.end;
  }
  out += contentMd.slice(last);
  return { text: out, spans };
}

/**
 * Working-copy edit for the /generate endpoint (§5): replace one scope's
 * output with `newOutput`, inserting "[=]" first if the scope had none yet.
 * The instruction and every other scope are untouched.
 */
export function setScopeOutput(contentMd: string, scope: TkScope, newOutput: string): string {
  const closeIdx = scope.end - 5; // start of "[/TK]"
  if (scope.outputStart !== null) {
    return contentMd.slice(0, scope.outputStart) + newOutput + contentMd.slice(closeIdx);
  }
  return contentMd.slice(0, closeIdx) + "[=]" + newOutput + contentMd.slice(closeIdx);
}

// --- Publish-time HTML disclosure (§3.2) ---
//
// Block spans are rendered independently (renderMarkdown on just that span)
// and spliced back in as a <div>, so a multi-paragraph generated block never
// gets split across the surrounding document's own markdown rendering. Inline
// spans stay inside the flowing text (sentinel-wrapped, not replaced) so
// surrounding markdown constructs — emphasis, links — still parse across the
// span boundary. Both use Unicode Private Use Area sentinels: never produced
// by normal authoring or by markdown-it's own output, so a plain string
// find/replace after rendering is safe. A scope with no recorded provenance
// (hand-authored output, never generated) gets no wrapper — see model.ts.

// U+E000/E001/E002 (Private Use Area) via fromCharCode, not literal glyphs —
// avoids relying on non-ASCII source bytes surviving every tool/editor layer
// unmangled. Never produced by normal authoring or by markdown-it's output.
const BLOCK_SENTINEL = String.fromCharCode(0xe000);
const INLINE_OPEN = String.fromCharCode(0xe001);
const INLINE_CLOSE = String.fromCharCode(0xe002);
const ENCODED_INLINE = new RegExp(`${encodeURIComponent(INLINE_OPEN)}|${encodeURIComponent(INLINE_CLOSE)}`, "g");


export interface AnnotatedDocument {
  /** Ready for renderMarkdown() (fragments) or resolveTransclusions() (threads). */
  text: string;
  /** Unique per-span token -> its independently-rendered `<div class="blyg-tk-gen">` replacement. */
  blockReplacements: Map<string, string>;
  hasInline: boolean;
}

/**
 * Prepare stripped content_md for rendering: provenanced block spans become
 * opaque single-line placeholder tokens (alone in their own paragraph, per
 * stripToOutput's block-position guarantee); provenanced inline spans are
 * sentinel-wrapped in place; spans with no provenance are left as plain text.
 */
export function annotateGenerated(strippedMd: string, spans: GeneratedSpan[], hasProvenance: boolean[]): AnnotatedDocument {
  let out = "";
  let last = 0;
  const blockReplacements = new Map<string, string>();
  let hasInline = false;
  spans.forEach((span, i) => {
    out += strippedMd.slice(last, span.start);
    const text = strippedMd.slice(span.start, span.end);
    if (!hasProvenance[i]) {
      out += text;
    } else if (span.block) {
      const token = `${BLOCK_SENTINEL}${i}${BLOCK_SENTINEL}`;
      blockReplacements.set(token, `<div class="blyg-tk-gen">${renderMarkdown(text)}</div>`);
      out += token;
    } else {
      hasInline = true;
      out += INLINE_OPEN + text + INLINE_CLOSE;
    }
    last = span.end;
  });
  out += strippedMd.slice(last);
  return { text: out, blockReplacements, hasInline };
}

/** Splice annotateGenerated()'s placeholders/sentinels into already-rendered HTML. */
export function applyGeneratedWrappers(html: string, doc: AnnotatedDocument): string {
  let out = html;
  for (const [token, blockHtml] of doc.blockReplacements) {
    // A function replacement: a string one expands `$&`, `$'` and kin found in
    // generated text (studio#2), so the splice would not be verbatim.
    out = out.replace(`<p>${token}</p>`, () => blockHtml);
  }
  if (doc.hasInline) {
    // Inline markers can land where a <span> cannot go (studio#3): linkify takes
    // them as URL characters and percent-encodes them into an href, and an
    // image's alt text keeps them inside a tag. There the marker is dropped and
    // the generated text stays as plain text; generated[] still discloses it.
    out = out.replace(ENCODED_INLINE, "");
    out = out
      .split(/(<[^>]*>)/)
      .map((part) =>
        part.startsWith("<")
          ? part.split(INLINE_OPEN).join("").split(INLINE_CLOSE).join("")
          : part.split(INLINE_OPEN).join('<span class="blyg-tk-gen">').split(INLINE_CLOSE).join("</span>"),
      )
      .join("");
  }
  return out;
}
