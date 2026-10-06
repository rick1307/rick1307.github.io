/*
  Wild Ledger current CONFIG store adapter.

  Community ID is the public lookup key. This module deliberately does not
  prescribe GitHub, Cloudflare, Supabase, or any other production provider.

  Production config:
    WILD_LEDGER_CONFIG.communityConfigEndpoint

  The endpoint may contain {communityId}, for example:
    https://config.example.com/community/{communityId}

  Or it may be a normal endpoint; Wild Ledger then adds ?community=ID.

  GET contract:
    Return either the complete current CONFIG JSON object, or
    { config: <object> }.

  WRITE CONTRACT — no app username/password is required:

  1. STAGE, before XRPL submission
     POST { action:"stage", communityId, configSchema,
            signedTransactionBlob, config }

     The signed blob is still private at this point. The service MUST:
       - decode and cryptographically verify the signed XRPL transaction;
       - verify it is the exact canonical no-op AccountSet carrying
         WILD-LEDGER/STATE/<ID>/CONFIG=<SCHEMA>;
       - verify its Account is the current Community Operating Wallet;
       - bind this complete CONFIG to that exact signed transaction hash;
       - return { transactionHash:"64HEX" }.

     This binds the staged CONFIG to a wallet-authorized transaction without
     putting the CONFIG itself, a CONFIG hash, or a hidden Community ID on XRPL.

  2. Wild Ledger submits THAT SAME signed blob to XRPL and waits for validated
     tesSUCCESS.

  3. FINALIZE
     POST { action:"finalize", communityId, transactionHash }

     The service MUST independently verify the staged transaction is now
     validated tesSUCCESS and was authorized for the community at that ledger
     position, then atomically replace the current CONFIG with the staged one.
     The transaction hash must be single-use/idempotent. Abandoned staged
     records should expire automatically.

  This avoids the insecure pattern of accepting a public transaction hash as a
  bearer credential after the transaction is already visible to everyone.
*/

import {
  canonicalCommunityId,
  normalizeCommunityConfigV1,
  COMMUNITY_CONFIG_SCHEMA
} from "./communityConfigSchema.js";

function configuredEndpoint() {
  return String(globalThis?.WILD_LEDGER_CONFIG?.communityConfigEndpoint || "").trim();
}

export function communityConfigStoreConfigured({ endpoint = "" } = {}) {
  return Boolean(String(endpoint || configuredEndpoint()).trim());
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

function responseConfigPayload(parsed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.config && typeof parsed.config === "object") {
    return parsed.config;
  }
  return parsed;
}

async function responseMessage(response) {
  try {
    const parsed = await response.json();
    return String(parsed?.message || parsed?.error || "").trim();
  } catch (_) {
    try { return String(await response.text()).trim(); } catch (_) { return ""; }
  }
}

export async function loadCurrentCommunityConfig({ communityId, endpoint = "", explicitUrl = "", cache = "no-store" } = {}) {
  const id = canonicalCommunityId(communityId);
  const url = communityConfigRequestUrl(id, { endpoint, explicitUrl });
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Error(`Current CONFIG for ${id} could not be loaded (${response.status}).`);

  const parsed = await response.json();
  const config = normalizeCommunityConfigV1(responseConfigPayload(parsed), { communityId: id });
  const canonicalText = JSON.stringify(config);
  return {
    communityId: id,
    url: url.href,
    config,
    canonicalText,
    bytes: new TextEncoder().encode(canonicalText).length
  };
}

export async function stageCurrentCommunityConfig({
  communityId,
  config,
  signedTransactionBlob,
  endpoint = ""
} = {}) {
  const id = canonicalCommunityId(communityId);
  const normalized = normalizeCommunityConfigV1(config, { communityId: id });
  const blob = String(signedTransactionBlob || "").trim().toUpperCase();
  if (!/^[A-F0-9]+$/.test(blob) || blob.length < 80) throw new Error("A signed XRPL CONFIG transaction is required before staging.");

  const url = communityConfigRequestUrl(id, { endpoint });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "stage",
      communityId: id,
      configSchema: COMMUNITY_CONFIG_SCHEMA,
      signedTransactionBlob: blob,
      config: normalized
    })
  });
  if (!response.ok) {
    const detail = await responseMessage(response);
    throw new Error(`CONFIG store could not stage ${id} (${response.status})${detail ? `: ${detail}` : "."}`);
  }

  let parsed = null;
  try { parsed = await response.json(); } catch (_) {}
  const transactionHash = String(parsed?.transactionHash || parsed?.txHash || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(transactionHash)) {
    throw new Error("CONFIG store staged the request but did not return the signed transaction hash.");
  }

  return { communityId: id, url: url.href, config: normalized, transactionHash };
}

export async function finalizeCurrentCommunityConfig({
  communityId,
  transactionHash,
  endpoint = ""
} = {}) {
  const id = canonicalCommunityId(communityId);
  const txHash = String(transactionHash || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(txHash)) throw new Error("A validated XRPL CONFIG transaction hash is required to finalize CONFIG.");

  const url = communityConfigRequestUrl(id, { endpoint });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "finalize", communityId: id, transactionHash: txHash })
  });
  if (!response.ok) {
    const detail = await responseMessage(response);
    throw new Error(`CONFIG store could not finalize ${id} (${response.status})${detail ? `: ${detail}` : "."}`);
  }

  if (response.status === 204) return { communityId: id, url: url.href, transactionHash: txHash, config: null };
  try {
    const parsed = await response.json();
    const payload = responseConfigPayload(parsed);
    const config = payload && typeof payload === "object"
      ? normalizeCommunityConfigV1(payload, { communityId: id })
      : null;
    return { communityId: id, url: url.href, transactionHash: txHash, config };
  } catch (_) {
    return { communityId: id, url: url.href, transactionHash: txHash, config: null };
  }
}
