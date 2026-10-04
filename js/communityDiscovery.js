/*
  Wild Ledger shared community discovery.

  Community existence comes from validated XRPL authority history:
  - brand-new communities are discovered from canonical Owner provisioning history;
  - legacy pre-authority communities can be confirmed from their one-time
    configured migration anchor and then resolved from XRPL;
  - explicit reference/demo communities may remain presentation-only.

  communityConfig.js supplies presentation only. A newly provisioned community
  does not need to be added there in order to be discovered.
*/

import { isClassicAddress } from "./xrplTransport.js";
import { resolveOwnerAuthority } from "./ownerAuthority.js";
import { resolveCommunityAuthority } from "./communityAuthority.js";

function backendIdFor(community) {
  return String(
    window.WILD_LEDGER_BACKEND_COMMUNITY_ID?.(community) ||
    community?.backendId ||
    community?.id ||
    ""
  ).trim().toUpperCase();
}

function presentationFor(id, configured, canonical = {}) {
  const isReference = configured?.directoryTone === "reference";
  const hasPresentation = Boolean(configured);

  return {
    communityId: id,
    namespace: canonical.namespace || configured?.leapNamespace || `${id}-LEAP`,
    operatingWallet: canonical.operatingWallet || "",
    ledger: Number.isFinite(Number(canonical.ledger)) ? Number(canonical.ledger) : null,
    hash: String(canonical.hash || ""),
    canonical: Boolean(canonical.canonical),
    source: canonical.source || (isReference ? "reference" : "configured"),
    configured: hasPresentation,
    reference: isReference,
    communityName: configured?.communityName || id,
    directoryStatus:
      configured?.directoryStatus ||
      (canonical.canonical ? "XRPL Community" : "Community"),
    directoryTone: configured?.directoryTone || (canonical.canonical ? "current" : ""),
    directoryDescription:
      configured?.directoryDescription ||
      (canonical.canonical
        ? "Canonical Wild Ledger community established on XRPL. Presentation setup has not been published yet."
        : "Wild Ledger community."),
    publicReady: hasPresentation,
    config: configured || null
  };
}

export async function discoverWildLedgerCommunities({ force = false } = {}) {
  const serverUrl = String(window.WILD_LEDGER_CONFIG?.xrplWebSocket || "").trim();
  if (!serverUrl) throw new Error("XRPL server is not configured.");

  const registry = window.WILD_LEDGER_COMMUNITY_REGISTRY || {};
  const configured = Object.values(registry);
  const configuredById = new Map();
  const configuredOrder = new Map();

  configured.forEach((community, index) => {
    const id = backendIdFor(community);
    if (!id) return;
    configuredById.set(id, community);
    configuredOrder.set(id, index);
  });

  const ownerState = await resolveOwnerAuthority({ serverUrl, force });
  if (!ownerState?.authorityEstablished) {
    throw new Error("Canonical Wild Ledger Owner authority is not established on XRPL.");
  }

  const records = new Map();

  // Legacy communities predate Owner provisioning. Their configured Operating
  // Wallet is only the migration anchor used to find their canonical XRPL state.
  for (const community of configured) {
    const id = backendIdFor(community);
    if (!id) continue;

    const configuredWallet = String(community?.operatingWallet || "").trim();
    if (isClassicAddress(configuredWallet)) {
      const authority = await resolveCommunityAuthority({ community, serverUrl, force });
      if (!authority?.authorityEstablished) {
        throw new Error(`${id} does not yet have canonical Community Operating Wallet authority on XRPL.`);
      }

      records.set(id, presentationFor(id, community, {
        canonical: true,
        source: "legacy-xrpl",
        namespace: authority.namespace || community.leapNamespace || `${id}-LEAP`,
        operatingWallet: authority.currentAccount || authority.canonicalCurrentAccount || configuredWallet,
        ledger: authority.initialStatement?.ledger,
        hash: authority.initialStatement?.hash
      }));
      continue;
    }

    // ZHR and any future deliberate demo/reference community can still be shown
    // as a reference surface without pretending it is canonical XRPL state.
    if (community?.directoryTone === "reference") {
      records.set(id, presentationFor(id, community, {
        canonical: false,
        source: "reference"
      }));
    }
  }

  // Brand-new communities are born by the Owner Wallet. This is the live path
  // that makes a newly provisioned ID appear without editing communityConfig.js.
  for (const item of ownerState.provisionedCommunities || []) {
    const id = String(item?.communityId || "").trim().toUpperCase();
    if (!id) continue;
    const community = configuredById.get(id) || null;

    records.set(id, presentationFor(id, community, {
      canonical: true,
      source: "owner-xrpl",
      namespace: item.namespace || `${id}-LEAP`,
      operatingWallet: item.operatingWallet,
      ledger: item.ledger,
      hash: item.hash
    }));
  }

  const communities = [...records.values()].sort((a, b) => {
    const aConfigured = configuredOrder.has(a.communityId);
    const bConfigured = configuredOrder.has(b.communityId);
    if (aConfigured && bConfigured) return configuredOrder.get(a.communityId) - configuredOrder.get(b.communityId);
    if (aConfigured) return -1;
    if (bConfigured) return 1;

    const aLedger = Number.isFinite(a.ledger) ? a.ledger : Number.MAX_SAFE_INTEGER;
    const bLedger = Number.isFinite(b.ledger) ? b.ledger : Number.MAX_SAFE_INTEGER;
    if (aLedger !== bLedger) return aLedger - bLedger;
    return a.communityId.localeCompare(b.communityId);
  });

  return {
    communities,
    ownerState,
    resolvedAt: new Date().toISOString()
  };
}
