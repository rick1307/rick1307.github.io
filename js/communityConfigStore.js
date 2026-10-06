/*
  Wild Ledger current CONFIG store adapter.

  The Community ID is the public lookup key. This module deliberately does not
  prescribe GitHub, Cloudflare, Supabase, or any other production provider.

  Production may configure WILD_LEDGER_CONFIG.communityConfigEndpoint with a URL
  containing {communityId}, or with a normal endpoint that accepts ?community=ID.
  Test harnesses may pass an explicit URL to prove the off-ledger contract.
*/

import { canonicalCommunityId, normalizeCommunityConfigV1 } from "./communityConfigSchema.js";

function configuredEndpoint() {
  return String(globalThis?.WILD_LEDGER_CONFIG?.communityConfigEndpoint || "").trim();
}

export function communityConfigRequestUrl(communityId, { endpoint = "", explicitUrl = "" } = {}) {
  const id = canonicalCommunityId(communityId);
  if (explicitUrl) return new URL(explicitUrl, globalThis.location?.href || import.meta.url);

  const base = String(endpoint || configuredEndpoint()).trim();
  if (!base) throw new Error("The current Community CONFIG store is not configured.");

  if (base.includes("{communityId}")) {
    return new URL(base.replaceAll("{communityId}", encodeURIComponent(id)), globalThis.location?.href || import.meta.url);
  }

  const url = new URL(base, globalThis.location?.href || import.meta.url);
  url.searchParams.set("community", id);
  return url;
}

export async function loadCurrentCommunityConfig({ communityId, endpoint = "", explicitUrl = "", cache = "no-store" } = {}) {
  const id = canonicalCommunityId(communityId);
  const url = communityConfigRequestUrl(id, { endpoint, explicitUrl });
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Error(`Current CONFIG for ${id} could not be loaded (${response.status}).`);

  const parsed = await response.json();
  const config = normalizeCommunityConfigV1(parsed, { communityId: id });
  const canonicalText = JSON.stringify(config);
  return {
    communityId: id,
    url: url.href,
    config,
    canonicalText,
    bytes: new TextEncoder().encode(canonicalText).length
  };
}
