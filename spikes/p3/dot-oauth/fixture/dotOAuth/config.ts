import type { JWK } from "jose";

export const subject = "klaxon-dot-fixture";
export const setupClientId = "klaxon-dot-test";
export const tasks = ["tasks:read", "tasks:write"] as const;
export const routes = {
  discovery: "/.well-known/oauth-authorization-server",
  authorize: "/dot-oauth/authorize",
  token: "/dot-oauth/token",
  jwks: "/dot-oauth/jwks",
  revoke: "/dot-oauth/revoke",
} as const;

type Env = Readonly<Record<string, string | undefined>>;
type PublicJwk = JWK & { kty: "RSA"; kid: string; e: string; n: string };
export type FixtureConfig = {
  origin: string; clientId: string; callback: string; resource: string;
  signingKey: JWK; publicKey: PublicJwk; passphraseHash: string; refresh: boolean; expiresAt: number;
  workspaceId: string; taskId: string; createId: string; updateId: string;
};
const base64 = /^[A-Za-z0-9_-]+$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const publicId = /^[A-Za-z0-9_.:~-]{1,200}$/u;

function approvedSite(value: string | undefined, platform: string | undefined): value is string {
  return !!value && /^https:\/\/[a-z0-9][a-z0-9-]*\.convex\.site$/u.test(value) &&
    (platform === undefined || platform === value);
}

export function publicCallbackUrl(value: string | undefined) {
  if (!value || value.length > 512 || /[?#*\s]|%(?:25)*2a/iu.test(value)) return;
  try {
    const url = new URL(value);
    const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(url.hostname);
    if (url.protocol === "https:" && dnsName && !/\.(?:localhost|local|internal|test|invalid|example)$/u.test(url.hostname) &&
        !url.username && !url.password && !url.port && url.href === value) return url;
  } catch { /* invalid configuration */ }
}

export function setupOrigin(values: Env) {
  const origin = values.DOT_OAUTH_SETUP_ORIGIN;
  return approvedSite(origin, values.CONVEX_SITE_URL) && !fixtureConfig(values) ? origin : undefined;
}

export function fixtureConfig(values: Env): FixtureConfig | undefined {
  if (values.DOT_OAUTH_ENABLED !== "true") return;
  const origin = values.DOT_OAUTH_ORIGIN;
  if (!approvedSite(origin, values.CONVEX_SITE_URL)) return;
  for (const [value, expected] of [[values.KLAXON_OAUTH_ISSUER, origin],
    [values.KLAXON_OAUTH_RESOURCE, origin + "/mcp"], [values.KLAXON_OAUTH_JWKS_URL, origin + routes.jwks]]) {
    if (value !== undefined && value !== expected) return;
  }
  const cutoff = values.DOT_OAUTH_EXPIRES_AT;
  const expiresAt = Number(cutoff);
  const now = Date.now();
  if (!cutoff || !/^\d{13}$/u.test(cutoff) || expiresAt <= now + 1000 || expiresAt > now + 3_600_000) return;
  const { DOT_OAUTH_WORKSPACE_ID: workspaceId, DOT_OAUTH_TASK_ID: taskId,
    DOT_OAUTH_CREATE_ID: createId, DOT_OAUTH_UPDATE_ID: updateId } = values;
  if (!workspaceId || !publicId.test(workspaceId) || !taskId || !publicId.test(taskId) ||
      !createId || !uuid.test(createId) || !updateId || !uuid.test(updateId) || createId === updateId) return;
  const callback = publicCallbackUrl(values.DOT_OAUTH_REDIRECT_URI);
  if (!callback) return;
  const clientId = values.DOT_OAUTH_CLIENT_ID;
  if (!clientId || !/^[A-Za-z0-9_.~-]{1,128}$/u.test(clientId)) return;
  const passphraseHash = values.DOT_OAUTH_PASSPHRASE_SHA256;
  if (!passphraseHash || !/^[0-9a-f]{64}$/u.test(passphraseHash)) return;
  const rawKey = values.DOT_OAUTH_PRIVATE_JWK;
  if (!rawKey || rawKey.length > 8192) return;
  try {
    const signingKey = JSON.parse(rawKey) as JWK | null;
    if (!signingKey || signingKey.kty !== "RSA" || !signingKey.kid || !/^[A-Za-z0-9_-]{1,64}$/u.test(signingKey.kid) ||
        !signingKey.d || !signingKey.n || !signingKey.e || signingKey.n.length < 342 ||
        !base64.test(signingKey.n) || !base64.test(signingKey.e) ||
        (signingKey.alg !== undefined && signingKey.alg !== "RS256")) return;
    const { kid, e, n } = signingKey;
    return { origin, clientId, callback: callback.href, resource: origin + "/mcp", signingKey,
      publicKey: { kid, e, n, kty: "RSA", alg: "RS256", use: "sig" }, passphraseHash,
      refresh: values.DOT_OAUTH_REFRESH === "true", expiresAt, workspaceId, taskId, createId, updateId };
  } catch { return; }
}
