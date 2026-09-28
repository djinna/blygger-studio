// Owner-only cookie auth — v0.1-plan §3.2.
// Cookie value: `${expiry}.${hex(hmacSHA256(expiry, COOKIE_SECRET))}`.

import type { Env } from "./types.ts";
import { hex } from "./util.ts";

export const COOKIE_NAME = "blyg_session";
const DEFAULT_SESSION_DAYS = 30;

/** SESSION_DAYS env (positive integer, max 400 — browsers cap Max-Age there), else 30. */
export function sessionSeconds(env: Env): number {
  const n = Number(env.SESSION_DAYS);
  const days = Number.isInteger(n) && n > 0 ? Math.min(n, 400) : DEFAULT_SESSION_DAYS;
  return days * 24 * 3600;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(new Uint8Array(sig));
}

/** Constant-time equality of two strings (compares SHA-256 digests, so length never leaks). */
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return (crypto.subtle as unknown as { timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean })
    .timingSafeEqual(da, db);
}

export async function checkPassword(env: Env, password: string): Promise<boolean> {
  return timingSafeEqualStr(env.OWNER_PASSWORD, password);
}

export async function issueSessionCookie(env: Env): Promise<string> {
  const seconds = sessionSeconds(env);
  const expiry = Math.floor(Date.now() / 1000) + seconds;
  const sig = await hmacHex(env.COOKIE_SECRET, String(expiry));
  const value = `${expiry}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifySession(env: Env, cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expiryStr, sig] = match[1].split(".");
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!Number.isInteger(expiry) || expiry * 1000 < Date.now()) return false;
  const expected = await hmacHex(env.COOKIE_SECRET, expiryStr);
  return timingSafeEqualStr(sig, expected);
}

/**
 * Bearer-token check for the quick-post endpoint. False when POST_TOKEN is
 * unset or too short to be a real secret, so an empty env can never match.
 */
export async function verifyPostToken(env: Env, authHeader: string | undefined): Promise<boolean> {
  const token = env.POST_TOKEN;
  if (!token || token.length < 32 || !authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  return timingSafeEqualStr(token, m[1]);
}
