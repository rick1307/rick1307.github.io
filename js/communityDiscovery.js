/*
  Wild Ledger shared community discovery.

  Community existence comes from validated XRPL authority history.
  communityConfig.js supplies presentation only. A newly provisioned community
  does not need to be added there in order to be discovered.

  Discovery is progressive: Owner provisioning history is published to the
  caller as soon as it is known, then legacy community authority is resolved.
  This keeps a slow legacy history scan from hiding newly provisioned communities.
*/

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
    publicReady: hasPresentation && (Boolean(canonical.canonical) || isReference),
    config: configured || null
  };
}

function sortedCommunities(records, configuredOrder) {
  return [...records.values()].sort((a, b) => {
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
}

export async function discoverWildLedgerCommunities({ force = false, onUpdate = null } = {}) {
  const serverUrl = String(window.WILD_LEDGER_CONFIG?.xrplWebSocket || "").trim();
  if (!serverUrl) throw new Error("XRPL server is not configured.");

  // Load the actual XRPL readers here so a dependency/load failure is caught by
  // the page's try/catch instead of leaving the screen frozen on “Reading…”.
  const [transportModule, ownerModule, communityModule] = await Promise.all([
    import("./xrplTransport.js?wl=20261004b"),
    import("./ownerAuthority.js?wl=20261004b"),
    import("./communityAuthority.js?wl=20261004b")
  ]);
  const { isClassicAddress } = transportModule;
  const { resolveOwnerAuthority } = ownerModule;
  const { resolveCommunityAuthority } = communityModule;

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
  const warnings = [];

  // Presentation-only reference/demo communities are deliberately not claimed
  // as canonical XRPL communities.
  for (const community of configured) {
    const id = backendIdFor(community);
    if (!id) continue;
    if (community?.directoryTone === "reference") {
      records.set(id, presentationFor(id, community, {
        canonical: false,
        source: "reference"
      }));
    }
  }

  // Brand-new communities are born in Owner provisioning history. Put them in
  // the result immediately so a legacy lookup cannot hide them.
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

  const publish = stage => {
    if (typeof onUpdate !== "function") return;
    onUpdate({
      stage,
      communities: sortedCommunities(records, configuredOrder),
      ownerState,
      warnings: [...warnings]
    });
  };

  publish("owner");

  // Legacy communities predate Owner provisioning. Their configured Operating
  // Wallet is only the migration anchor used to find canonical XRPL authority.
  for (const community of configured) {
    const id = backendIdFor(community);
    if (!id || records.has(id)) continue;

    const configuredWallet = String(community?.operatingWallet || "").trim();
    if (!isClassicAddress(configuredWallet)) continue;

    try {
      publish(`legacy:${id}:reading`);
      const authority = await resolveCommunityAuthority({ community, serverUrl, force });
      if (!authority?.authorityEstablished) {
        warnings.push(`${id} canonical Operating Wallet authority is not yet established on XRPL.`);
        publish(`legacy:${id}:not-established`);
        continue;
      }

      records.set(id, presentationFor(id, community, {
        canonical: true,
        source: "legacy-xrpl",
        namespace: authority.namespace || community.leapNamespace || `${id}-LEAP`,
        operatingWallet: authority.currentAccount || authority.canonicalCurrentAccount || configuredWallet,
        ledger: authority.initialStatement?.ledger,
        hash: authority.initialStatement?.hash
      }));
      publish(`legacy:${id}:complete`);
    } catch (error) {
      warnings.push(`${id}: ${error?.message || String(error)}`);
      publish(`legacy:${id}:error`);
    }
  }

  const communities = sortedCommunities(records, configuredOrder);
  return {
    communities,
    ownerState,
    warnings,
    resolvedAt: new Date().toISOString()
  };
}
