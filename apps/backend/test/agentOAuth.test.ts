import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { oauthChallenge, oauthConfig, oauthMetadata, verifyOAuthToken } from "../convex/model/agentOAuth";

const config = {
  issuer: "https://issuer.example/tenant",
  jwksUrl: "https://issuer.example/keys",
  resource: "https://klaxon.example/mcp",
};
const now = Math.floor(Date.now() / 1000);
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "synthetic", use: "sig" }] };
});

async function token(overrides: JWTPayload = {}, header: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: config.issuer, sub: "subject", aud: config.resource, exp: now + 300, nbf: now - 10,
    scope: "tasks:read something-else tasks:read", client_id: "client",
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "synthetic", ...header }).sign(keys.privateKey);
}

function fetchKeys() {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(jwks));
}

describe("MCP OAuth access tokens", () => {
  it("verifies against only the configured JWKS and returns a bounded principal", async () => {
    const fetcher = fetchKeys();
    const principal = await verifyOAuthToken(await token(), config, fetcher);
    expect(principal).toEqual({
      issuer: config.issuer, subject: "subject", clientId: "client", scopes: ["tasks:read"], expiresAt: (now + 300) * 1000,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(config.jwksUrl, expect.objectContaining({ redirect: "manual" }));
  });

  it.each([
    { iss: "https://somewhere-else.example" },
    { aud: "https://klaxon.example/" },
    { exp: now - 1 },
    { exp: undefined },
    { nbf: now + 60 },
    { sub: "" },
    { client_id: undefined },
    { azp: "different-client" },
    { scope: ["tasks:read"] },
  ])("denies invalid access-token claims %j", async (claims) => {
    await expect(verifyOAuthToken(await token(claims), config, fetchKeys())).rejects.toThrow("AGENT_UNAUTHORIZED");
  });

  it("rejects ID token headers before requesting keys", async () => {
    const fetcher = fetchKeys();
    await expect(verifyOAuthToken(await token({}, { typ: "JWT" }), config, fetcher)).rejects.toThrow("AGENT_UNAUTHORIZED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects header-controlled key locations before requesting keys", async () => {
    const fetcher = fetchKeys();
    const suppliedKey = await token({}, { jku: "https://unexpected.example/keys" });
    await expect(verifyOAuthToken(suppliedKey, config, fetcher)).rejects.toThrow("AGENT_UNAUTHORIZED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects JWKS redirects and HTTPS-to-HTTP configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.redirect("https://unexpected.example/keys"));
    await expect(verifyOAuthToken(await token(), config, fetcher)).rejects.toThrow("AGENT_UNAUTHORIZED");
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(verifyOAuthToken(await token(), { ...config, jwksUrl: "http://issuer.example/keys" }, fetcher))
      .rejects.toThrow("AGENT_UNAUTHORIZED");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a token with the wrong signing key", async () => {
    const other = await generateKeyPair("RS256");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      keys: [{ ...await exportJWK(other.publicKey), kid: "synthetic" }],
    }));
    await expect(verifyOAuthToken(await token(), config, fetcher)).rejects.toThrow("AGENT_UNAUTHORIZED");
  });
});

describe("OAuth metadata", () => {
  it("uses the configured audience to construct the discovery challenge", () => {
    expect(oauthChallenge(config)).toContain(
      'resource_metadata="https://klaxon.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(oauthMetadata(config)).toMatchObject({
      resource: config.resource, authorization_servers: [config.issuer], bearer_methods_supported: ["header"],
    });
  });

  it("leaves discovery inactive with missing or invalid configuration", () => {
    expect(oauthConfig({})).toBeUndefined();
    expect(oauthConfig({
      KLAXON_OAUTH_ISSUER: config.issuer,
      KLAXON_OAUTH_JWKS_URL: config.jwksUrl,
      KLAXON_OAUTH_RESOURCE: "https://klaxon.example/another-route",
    })).toBeUndefined();
  });
});
