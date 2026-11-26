import { v, type Infer } from "convex/values";

export const principalFields = { issuer: v.string(), subject: v.string(), clientId: v.string() };
export const oauthPrincipal = v.object(principalFields);
export type OAuthPrincipal = Infer<typeof oauthPrincipal>;
type Mapping = OAuthPrincipal & { workspacePublicId: string; credentialPublicId: string };

export function samePrincipal(left: OAuthPrincipal | undefined, right: OAuthPrincipal) {
  return left?.issuer === right.issuer && left.subject === right.subject && left.clientId === right.clientId;
}

// A small operator-managed deployment allowlist. Ambiguous or malformed lists disable binding.
export function oauthBindings(): Mapping[] {
  const input = process.env.KLAXON_OAUTH_BINDINGS;
  if (!input || input.length > 32_768) return [];
  try {
    const mappings = JSON.parse(input);
    if (!Array.isArray(mappings) || mappings.length > 64) return [];
    const principals = new Set<string>(), targets = new Set<string>();
    for (const entry of mappings) {
      if (!entry || typeof entry !== "object" ||
        !["issuer","subject","clientId","workspacePublicId","credentialPublicId"].every(k =>
          typeof entry[k] === "string" && entry[k].length > 0 && entry[k].length <= 512)) return [];
      const issuer = new URL(entry.issuer);
      if (issuer.protocol !== "https:" || issuer.search || issuer.hash || issuer.username || issuer.password) return [];
      const principal = JSON.stringify([entry.issuer, entry.subject, entry.clientId]);
      const target = JSON.stringify([entry.workspacePublicId, entry.credentialPublicId]);
      if (principals.has(principal) || targets.has(target)) return [];
      principals.add(principal);
      targets.add(target);
    }
    return mappings;
  } catch {
    return [];
  }
}
