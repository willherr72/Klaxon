import { base64url, importJWK, SignJWT } from "jose";
import { subject, tasks, type FixtureConfig } from "./config";

const accessLifetime = 300;
export const opaquePattern = /^[A-Za-z0-9_-]{43}$/u;
export const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/u;
const encoder = new TextEncoder();

export function opaque() {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export async function digest(value: string) {
  return base64url.encode(await sha256(value));
}

export async function validPassphrase(candidate: string, expected: string) {
  if (!candidate || candidate.length > 128) return false;
  const bytes = await sha256(candidate);
  let mismatch = 0;
  for (let i = 0; i < bytes.length; i++) {
    mismatch |= bytes[i]! ^ Number.parseInt(expected.slice(i * 2, i * 2 + 2), 16);
  }
  return mismatch === 0;
}

export function requestedScopes(value: string | null, config: FixtureConfig) {
  if (!value || value.length > 64) return;
  const requested = value.split(" ");
  const supported = config.refresh ? [...tasks, "offline_access"] : [...tasks];
  if (new Set(requested).size !== requested.length || requested.some(s => !supported.includes(s)) ||
      !tasks.some(scope => requested.includes(scope))) return;
  return supported.filter(scope => requested.includes(scope));
}

export async function signAccess(config: FixtureConfig, granted: string[]) {
  const scope = tasks.filter(item => granted.includes(item)).join(" ");
  const now = Math.floor(Date.now() / 1000);
  const key = await importJWK(config.signingKey, "RS256");
  const expires = Math.min(now + accessLifetime, Math.floor(config.expiresAt / 1000));
  if (expires <= now) throw new Error("Fixture expired");
  const accessToken = await new SignJWT({ scope, client_id: config.clientId })
    .setProtectedHeader({ alg: "RS256", kid: config.publicKey.kid, typ: "at+jwt" })
    .setIssuer(config.origin).setAudience(config.resource).setSubject(subject)
    .setIssuedAt(now).setExpirationTime(expires).setJti(crypto.randomUUID()).sign(key);
  return { access_token: accessToken, token_type: "Bearer", expires_in: expires - now, scope };
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? ""));
}

export async function boundedForm(request: Request) {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const chunks = new Uint8Array(4096);
  let position = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (position + read.value.length > chunks.length) {
        await reader.cancel();
        return;
      }
      chunks.set(read.value, position);
      position += read.value.length;
    }
    const data = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(chunks.subarray(0, position)));
    if (new Set(data.keys()).size !== [...data].length) return;
    return data;
  } catch { return; }
}
