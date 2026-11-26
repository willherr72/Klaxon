import { agentScopeNames as scopes } from "./agentScopes";
import { ConvexError } from "convex/values";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import { env } from "../_generated/server";
import { json, readBoundedJson } from "./agentHttp";

export const oauthMetadataPath = "/.well-known/oauth-protected-resource/mcp";
export const maxOAuthTokenLength = 8192;

type Environment = Readonly<Record<string, string | undefined>>;
export type OAuthConfig = { issuer: string; jwksUrl: string; resource: string };
export type VerifiedOAuth = {
  issuer: string;
  subject: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

function httpsUrl(value: string | undefined) {
  if (!value || /[\s?#]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function validConfig(config: OAuthConfig) {
  const resource = httpsUrl(config.resource);
  return resource?.pathname === "/mcp" && resource.href === config.resource
    && httpsUrl(config.issuer) && httpsUrl(config.jwksUrl);
}

export function oauthConfig(values: Environment = env): OAuthConfig | undefined {
  const issuer = values.KLAXON_OAUTH_ISSUER;
  const jwksUrl = values.KLAXON_OAUTH_JWKS_URL;
  const resource = values.KLAXON_OAUTH_RESOURCE;
  if (!issuer || !jwksUrl || !resource) return undefined;
  const config = { issuer, jwksUrl, resource };
  return validConfig(config) ? config : undefined;
}

export function oauthMetadata(config: OAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...scopes],
    bearer_methods_supported: ["header"],
  };
}

export function oauthMetadataResponse() {
  const config = oauthConfig();
  return config ? json(oauthMetadata(config)) : json({ error: { code: "NOT_FOUND" } }, 404);
}

export function oauthChallenge(config: OAuthConfig) {
  const metadata = new URL(oauthMetadataPath, config.resource);
  return 'Bearer resource_metadata="' + metadata.href + '"';
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
}

function loadKeys(url: string, fetcher: typeof fetch) {
  return createRemoteJWKSet(new URL(url), {
    timeoutDuration: 3000,
    cacheMaxAge: 60_000,
    [customFetch]: async (target, init) => {
      const response = await fetcher(target, init);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== target)) {
        throw new Error("Unable to load issuer keys");
      }
      return Response.json(await readBoundedJson(response, 64 * 1024));
    },
  });
}

let cachedKeys: { url: string; resolve: ReturnType<typeof loadKeys> } | undefined;

function keyResolver(url: string, fetcher?: typeof fetch) {
  if (fetcher) return loadKeys(url, fetcher);
  if (cachedKeys?.url !== url) cachedKeys = { url, resolve: loadKeys(url, fetch) };
  return cachedKeys.resolve;
}

export async function verifyOAuthToken(token: string, config: OAuthConfig, fetcher?: typeof fetch): Promise<VerifiedOAuth> {
  try {
    if (!validConfig(config) || token.length > maxOAuthTokenLength) throw new Error();
    const { alg, typ, kid, jku, jwk, x5u, x5c } = decodeProtectedHeader(token);
    const type = typ?.toLowerCase();
    if (alg !== "RS256" || (type !== "at+jwt" && type !== "application/at+jwt")
      || !validIdentity(kid) || jku !== undefined || jwk !== undefined || x5u !== undefined || x5c !== undefined) {
      throw new Error();
    }
    const { payload } = await jwtVerify(token, keyResolver(config.jwksUrl, fetcher), {
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: config.resource,
      requiredClaims: ["exp", "sub"],
    });
    const { sub, client_id, azp, exp, scope } = payload;
    const expiresAt = typeof exp === "number" ? exp * 1000 : NaN;
    if (!validIdentity(sub) || !validIdentity(client_id) || (azp !== undefined && azp !== client_id)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
      || typeof scope !== "string" || scope.length > 512) {
      throw new Error();
    }
    const granted = scope.split(" ");
    return { issuer: config.issuer, subject: sub, clientId: client_id,
      scopes: scopes.filter(value => granted.includes(value)), expiresAt };
  } catch {
    throw new ConvexError("AGENT_UNAUTHORIZED");
  }
}
