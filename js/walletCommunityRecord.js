/*
  Wild Ledger cross-community wallet record — session cache only.

  Purpose:
  - Read one public XRPL wallet once for the browser session.
  - Discover canonical Wild Ledger communities from XRPL.
  - Reconstruct this wallet's community relationships from ledger evidence.
  - Cache only the compact derived summary in sessionStorage.

  This module does not create a database and does not store private keys,
  seed phrases, signer secrets, or other private wallet material.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";
import { discoverWildLedgerCommunities } from "./communityDiscovery.js";
import {
  resolveCommunityAuthority,
  isAuthorizedAtLedger
} from "./communityAuthority.js";
import {
  loadRecognitionCatalog,
  recognitionAvailabilityFromCatalog
} from "./recognitionCatalog.js";
import { readCommunityRequestStatus } from "./communitySetup.js";

export const WILD_LEDGER_ACTIVE_WALLET_KEY = "wildLedger.activeWallet";
export const WILD_LEDGER_COMMUNITY_RECORD_KEY = "wildLedger.communityRecord";
export const WILD_LEDGER_COMMUNITY_RECORD_VERSION = 3;

const LEAP_HISTORY_KEYS = ["BADGE", "EVENT", "CHALLENGE"];
const RIPPLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const IN_FLIGHT = new Map();

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function sessionRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (_) {}
}

function normalizeWallet(value) {
  const wallet = String(value || "").trim();
  return isClassicAddress(wallet) ? wallet : "";
}

function readCachedRecord() {
  const raw = sessionGet(WILD_LEDGER_COMMUNITY_RECORD_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== WILD_LEDGER_COMMUNITY_RECORD_VERSION) return null;
    if (!normalizeWallet(parsed.wallet)) return null;
    if (!Array.isArray(parsed.communities)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function getCachedWildLedgerCommunityRecord(wallet = "") {
  const target = normalizeWallet(wallet || sessionGet(WILD_LEDGER_ACTIVE_WALLET_KEY));
  if (!target) return null;

  const cached = readCachedRecord();
  return cached?.wallet === target ? cached : null;
}

export function clearWildLedgerCommunityRecord() {
  sessionRemove(WILD_LEDGER_COMMUNITY_RECORD_KEY);
}

function normalizeTx(entry) {
  return entry?.tx_json || entry?.tx || entry?.transaction || entry || {};
}

function transactionSucceeded(entry) {
  if (entry?.validated === false) return false;
  const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
  const result = meta?.TransactionResult ?? meta?.transaction_result;
  return !result || result === "tesSUCCESS";
}

function entryLedgerIndex(entry, tx = normalizeTx(entry)) {
  const value = entry?.ledger_index ?? entry?.ledgerIndex ?? tx?.ledger_index ?? tx?.ledgerIndex ?? tx?.inLedger;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function entryTransactionIndex(entry) {
  const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
  const value = entry?.tx_index ?? entry?.transaction_index ?? meta?.TransactionIndex ?? meta?.transaction_index;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rippleTimeToIso(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  return new Date(RIPPLE_EPOCH_MS + Number(seconds) * 1000).toISOString();
}

function entryTime(entry, tx = normalizeTx(entry)) {
  const raw = entry?.close_time_iso || entry?.date || tx?.date || null;
  if (typeof raw === "number") return rippleTimeToIso(raw);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hexToText(value) {
  if (!value || typeof value !== "string") return "";
  if (!/^[A-Fa-f0-9]+$/.test(value) || value.length % 2 !== 0) return value;

  try {
    const bytes = new Uint8Array(value.match(/.{2}/g).map(pair => parseInt(pair, 16)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0+$/g, "");
  } catch (_) {
    return value;
  }
}

function canonicalLeapAmount(amount, issuer, currency) {
  if (!amount || typeof amount !== "object") return null;
  if (String(amount.issuer || "") !== String(issuer || "")) return null;
  if (String(amount.currency || "").toUpperCase() !== String(currency || "").toUpperCase()) return null;

  const value = Number(amount.value);
  return Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : null;
}

function isCanonicalLeapAmount(amount, issuer, currency) {
  return canonicalLeapAmount(amount, issuer, currency) !== null;
}

function extractCreatedCheckId(meta) {
  const nodes = meta?.AffectedNodes || meta?.affected_nodes || [];

  for (const wrapper of nodes) {
    const node = wrapper?.CreatedNode || wrapper?.created_node;
    if (!node) continue;
    if ((node.LedgerEntryType || node.ledger_entry_type) !== "Check") continue;
    return node.LedgerIndex || node.ledger_index || "";
  }

  return "";
}

function parseStructuredMemoData(text) {
  const facts = [];
  if (!text) return facts;

  for (const piece of String(text).split("|")) {
    const equals = piece.indexOf("=");
    if (equals <= 0) continue;

    const key = piece.slice(0, equals).trim().toUpperCase();
    const value = piece.slice(equals + 1).trim();
    if (LEAP_HISTORY_KEYS.includes(key) && value) facts.push({ key, value });
  }

  return facts;
}

function parseCanonicalLeapMemo(text, namespace) {
  const value = String(text || "").trim();
  const prefix = `${namespace}/`;
  if (!value || !value.toUpperCase().startsWith(prefix.toUpperCase())) return null;

  const payload = value.slice(prefix.length);
  const equals = payload.indexOf("=");
  if (equals <= 0) return null;

  const key = payload.slice(0, equals).trim().toUpperCase();
  const factValue = payload.slice(equals + 1).trim().toUpperCase();
  if (!LEAP_HISTORY_KEYS.includes(key)) return null;
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(factValue)) return null;

  return { key, value: factValue };
}

function extractLeapFacts(tx, namespace) {
  const facts = [];
  const seen = new Set();
  const memos = Array.isArray(tx?.Memos) ? tx.Memos : [];

  function addFact(fact) {
    if (!fact) return;
    const signature = `${fact.key}=${fact.value}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    facts.push(fact);
  }

  for (const wrapper of memos) {
    const memo = wrapper?.Memo || {};
    const type = hexToText(memo.MemoType).trim();
    const format = hexToText(memo.MemoFormat).trim();
    const data = hexToText(memo.MemoData).trim();

    addFact(parseCanonicalLeapMemo(data, namespace));
    addFact(parseCanonicalLeapMemo(type, namespace));
    addFact(parseCanonicalLeapMemo(format, namespace));

    if (type.toUpperCase() === namespace.toUpperCase()) {
      for (const fact of parseStructuredMemoData(data)) addFact(fact);
    }

    const legacyPrefix = `${namespace}/`;
    if (type.toUpperCase().startsWith(legacyPrefix.toUpperCase()) && !type.includes("=")) {
      const key = type.slice(legacyPrefix.length).trim().toUpperCase();

      if (LEAP_HISTORY_KEYS.includes(key) && data) {
        addFact({ key, value: String(data).trim().toUpperCase() });
      } else if (key === "NEW-MEMBER") {
        addFact({ key: "BADGE", value: "NEW-MEMBER" });
      }
    }
  }

  return facts;
}

function beforeAuthorityActivation(authority, entry, tx = normalizeTx(entry)) {
  if (!authority?.initialStatement) return true;

  const ledger = entryLedgerIndex(entry, tx);
  if (!Number.isFinite(ledger)) return false;

  const txIndex = entryTransactionIndex(entry);
  const initialLedger = Number(authority.initialStatement.ledger);
  const initialIndex = Number.isFinite(Number(authority.initialStatement.txIndex))
    ? Number(authority.initialStatement.txIndex)
    : -1;
  const index = Number.isFinite(txIndex) ? txIndex : -1;

  return ledger < initialLedger || (ledger === initialLedger && index < initialIndex);
}

function officialRecognitionSource({ entry, tx, authority, legacyDistributors }) {
  const ledger = entryLedgerIndex(entry, tx);
  const txIndex = entryTransactionIndex(entry);

  if (authority && isAuthorizedAtLedger(authority, tx.Account, ledger, txIndex)) return true;
  return beforeAuthorityActivation(authority, entry, tx) && legacyDistributors.has(String(tx.Account || ""));
}

function recognitionFactAvailable({ fact, entry, tx, catalog }) {
  if (!fact?.key || !fact?.value || !catalog) return false;

  const result = recognitionAvailabilityFromCatalog({
    catalog,
    category: fact.key,
    id: fact.value,
    ledgerIndex: entryLedgerIndex(entry, tx),
    transactionIndex: entryTransactionIndex(entry)
  });

  return result.available === true;
}

function recognitionFactCurrentlyIgnored(fact, catalog) {
  if (!fact?.key || !fact?.value || !catalog) return false;

  const category = String(fact.key).trim().toUpperCase();
  const id = String(fact.value).trim().toUpperCase();
  const record = (Array.isArray(catalog.records) ? catalog.records : []).find(item =>
    String(item?.category || "").trim().toUpperCase() === category &&
    String(item?.id || "").trim().toUpperCase() === id
  );

  return record?.state === "IGNORED";
}

function buildCashedCheckAmounts(entries, issuer, currency) {
  const result = new Map();

  for (const entry of entries) {
    if (!entry || !transactionSucceeded(entry)) continue;

    const tx = normalizeTx(entry);
    if (tx.TransactionType !== "CheckCash" || !tx.CheckID) continue;

    const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
    const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
    let value = canonicalLeapAmount(delivered, issuer, currency);

    if (value === null) value = canonicalLeapAmount(tx.Amount, issuer, currency);
    if (value !== null) result.set(String(tx.CheckID), value);
  }

  return result;
}

function officialLeapHistoryRecord({
  entry,
  memberAccount,
  cashedCheckAmounts,
  issuer,
  currency,
  namespace,
  authority,
  catalog,
  legacyDistributors
}) {
  if (!entry || !transactionSucceeded(entry)) return null;

  const tx = normalizeTx(entry);
  if (!officialRecognitionSource({ entry, tx, authority, legacyDistributors })) return null;
  if (String(tx.Destination || "") !== memberAccount) return null;

  let earnedAmount = null;
  let checkId = "";

  if (tx.TransactionType === "CheckCreate") {
    if (!isCanonicalLeapAmount(tx.SendMax, issuer, currency)) return null;
    checkId = extractCreatedCheckId(entry?.meta || entry?.metaData || entry?.metadata || {});
    if (!checkId || !cashedCheckAmounts.has(checkId)) return null;
    earnedAmount = cashedCheckAmounts.get(checkId);
  } else if (tx.TransactionType === "Payment") {
    const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
    const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
    const requested = tx.DeliverMax || tx.Amount;

    if (!isCanonicalLeapAmount(delivered, issuer, currency) && !isCanonicalLeapAmount(requested, issuer, currency)) {
      return null;
    }

    earnedAmount = canonicalLeapAmount(delivered, issuer, currency);
    if (earnedAmount === null) earnedAmount = canonicalLeapAmount(tx.Amount, issuer, currency);
  } else {
    return null;
  }

  if (earnedAmount === null) return null;

  const facts = extractLeapFacts(tx, namespace);
  if (facts.length !== 1) return null;
  if (!recognitionFactAvailable({ fact: facts[0], entry, tx, catalog })) return null;

  return {
    hash: String(entry?.hash || tx?.hash || ""),
    checkId,
    earnedAmount,
    ledger: entryLedgerIndex(entry, tx),
    transactionIndex: entryTransactionIndex(entry),
    time: entryTime(entry, tx),
    facts,
    recognitionIgnored: recognitionFactCurrentlyIgnored(facts[0], catalog)
  };
}

function singleOccurrenceRecognitionRecords(records) {
  const ordered = [...records].sort((a, b) => {
    const ledgerDifference = Number(a?.ledger || 0) - Number(b?.ledger || 0);
    if (ledgerDifference) return ledgerDifference;

    const aIndex = Number.isFinite(Number(a?.transactionIndex)) ? Number(a.transactionIndex) : -1;
    const bIndex = Number.isFinite(Number(b?.transactionIndex)) ? Number(b.transactionIndex) : -1;
    if (aIndex !== bIndex) return aIndex - bIndex;

    return String(a?.hash || "").localeCompare(String(b?.hash || ""));
  });

  const seen = { EVENT: new Set(), CHALLENGE: new Set() };
  const kept = [];

  for (const record of ordered) {
    const fact = Array.isArray(record?.facts) ? record.facts[0] : null;
    if (!fact || fact.key === "BADGE") {
      kept.push(record);
      continue;
    }

    if (fact.key === "EVENT" || fact.key === "CHALLENGE") {
      const id = String(fact.value || "");
      if (seen[fact.key].has(id)) continue;
      seen[fact.key].add(id);
    }

    kept.push(record);
  }

  return kept;
}

function rankFor(community, earnedLeap) {
  const configuredRanks = Array.isArray(community?.ranks) && community.ranks.length
    ? community.ranks
    : [
        { min: 1, name: "Deckhand" },
        { min: 5, name: "Bosun" },
        { min: 10, name: "Quartermaster" },
        { min: 25, name: "First Mate" },
        { min: 51, name: "Master of the Leap" }
      ];

  const ranks = [...configuredRanks]
    .map(item => ({ min: Number(item?.min), name: String(item?.name || "").trim() }))
    .filter(item => Number.isFinite(item.min) && item.min >= 0 && item.name)
    .sort((a, b) => a.min - b.min);

  let current = null;
  for (const rank of ranks) {
    if (earnedLeap >= rank.min) current = rank;
  }

  return current?.name || community?.unrankedRankLabel || "Not ranked";
}

function communityObjectFromDiscovery(record) {
  if (record?.config) return record.config;

  return {
    id: String(record?.communityId || "").trim().toLowerCase(),
    backendId: String(record?.communityId || "").trim().toUpperCase(),
    communityName: String(record?.communityName || record?.communityId || "Community"),
    leapNamespace: String(record?.namespace || `${record?.communityId || ""}-LEAP`),
    operatingWallet: String(record?.operatingWallet || ""),
    unrankedRankLabel: "Not ranked",
    ranks: [
      { min: 1, name: "Deckhand" },
      { min: 5, name: "Bosun" },
      { min: 10, name: "Quartermaster" },
      { min: 25, name: "First Mate" },
      { min: 51, name: "Master of the Leap" }
    ]
  };
}

async function readWalletLedgerData({ wallet, serverUrl, issuer, currency }) {
  const client = new DirectXRPLClient(serverUrl);

  try {
    await client.connect();

    let leapBalance = null;
    let linesError = "";

    try {
      const linesResponse = await client.request("account_lines", {
        account: wallet,
        peer: issuer,
        ledger_index: "validated",
        limit: 400
      }, 15000);

      const lines = Array.isArray(linesResponse?.result?.lines) ? linesResponse.result.lines : [];
      const leapLine = lines.find(line =>
        String(line?.account || "") === issuer &&
        String(line?.currency || "").toUpperCase() === String(currency || "").toUpperCase()
      );

      const parsed = Number(leapLine?.balance || 0);
      leapBalance = Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
      linesError = error?.message || String(error);
    }

    const entries = [];
    let marker;

    do {
      const fields = {
        account: wallet,
        ledger_index_min: -1,
        ledger_index_max: -1,
        binary: false,
        forward: true,
        limit: 400
      };
      if (marker !== undefined && marker !== null) fields.marker = marker;

      const response = await client.request("account_tx", fields, 30000);
      const result = response.result || {};
      entries.push(...(Array.isArray(result.transactions) ? result.transactions : []));
      marker = result.marker;
    } while (marker !== undefined && marker !== null);

    return { leapBalance, linesError, entries };
  } finally {
    client.close();
  }
}

function summarizeCommunityRelationship({
  discovered,
  community,
  wallet,
  authority,
  catalog,
  entries,
  cashedCheckAmounts,
  issuer,
  currency,
  legacyDistributors
}) {
  const namespace = String(discovered?.namespace || community?.leapNamespace || "").trim();
  const records = [];

  if (authority?.authorityEstablished && catalog) {
    for (const entry of entries) {
      const record = officialLeapHistoryRecord({
        entry,
        memberAccount: wallet,
        cashedCheckAmounts,
        issuer,
        currency,
        namespace,
        authority,
        catalog,
        legacyDistributors
      });
      if (record) records.push(record);
    }
  }

  const uniqueRecords = singleOccurrenceRecognitionRecords(records);
  const earnedLeap = uniqueRecords.reduce((sum, record) => {
    const value = Number(record?.earnedAmount);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);

  const authorityAccounts = Array.isArray(authority?.accounts) ? authority.accounts : [];
  const canonicalProvisionWallet = String(discovered?.operatingWallet || "");
  const currentAuthorityWallet = String(authority?.currentAccount || authority?.canonicalCurrentAccount || canonicalProvisionWallet || "");
  const currentOperator = currentAuthorityWallet === wallet;
  const historicalOperator = currentOperator || authorityAccounts.includes(wallet);
  const member = earnedLeap > 0;

  return {
    communityId: String(discovered?.communityId || community?.backendId || community?.id || "").trim().toUpperCase(),
    communityKey: String(community?.id || discovered?.communityId || "").trim().toLowerCase(),
    communityName: String(discovered?.communityName || community?.communityName || discovered?.communityId || "Community"),
    namespace,
    canonical: Boolean(discovered?.canonical),
    configured: Boolean(discovered?.configured),
    source: String(discovered?.source || ""),
    member,
    earnedLeap,
    rank: rankFor(community, earnedLeap),
    currentOperator,
    historicalOperator,
    setupRequired: Boolean(discovered?.canonical && currentOperator && !discovered?.configured),
    recognitionCount: uniqueRecords.length
  };
}

function compactOperatorJourney(status) {
  const state = String(status?.state || "NONE").toUpperCase();
  const request = status?.request
    ? {
        ledger: Number(status.request.ledger) || null,
        hash: String(status.request.hash || ""),
        feeXrp: String(status.request.feeXrp || "")
      }
    : null;
  const community = status?.community
    ? {
        communityId: String(status.community.communityId || "").trim().toUpperCase(),
        namespace: String(status.community.namespace || ""),
        operatingWallet: String(status.community.operatingWallet || ""),
        firstOperatingWallet: String(status.community.firstOperatingWallet || ""),
        ledger: Number(status.community.ledger) || null,
        hash: String(status.community.hash || "")
      }
    : null;
  const transferredCommunity = status?.transferredCommunity
    ? {
        communityId: String(status.transferredCommunity.communityId || "").trim().toUpperCase(),
        namespace: String(status.transferredCommunity.namespace || ""),
        firstOperatingWallet: String(status.transferredCommunity.firstOperatingWallet || ""),
        ledger: Number(status.transferredCommunity.ledger) || null,
        hash: String(status.transferredCommunity.hash || "")
      }
    : null;

  return {
    state,
    request,
    community,
    transferredCommunity,
    currentCommunityCount: Array.isArray(status?.currentlyOperatedCommunities)
      ? status.currentlyOperatedCommunities.length
      : 0,
    initialCommunityCount: Array.isArray(status?.initialProvisionedCommunities)
      ? status.initialProvisionedCommunities.length
      : 0
  };
}

export async function buildWildLedgerCommunityRecord({
  wallet,
  force = false,
  onProgress = null
} = {}) {
  const target = normalizeWallet(wallet || sessionGet(WILD_LEDGER_ACTIVE_WALLET_KEY));
  if (!target) throw new Error("A valid active XRPL wallet is required.");

  const config = window.WILD_LEDGER_CONFIG;
  const serverUrl = String(config?.xrplWebSocket || "").trim();
  const issuer = String(config?.leapIssuer || "").trim();
  const currency = String(config?.leapCurrency || "").trim();
  const legacyDistributors = new Set(
    Array.isArray(config?.leapDistributors)
      ? config.leapDistributors.map(value => String(value || "").trim()).filter(Boolean)
      : []
  );

  if (!serverUrl || !issuer || !currency) {
    throw new Error("Wild Ledger XRPL/LEAP configuration is incomplete.");
  }

  const publish = (stage, detail = {}) => {
    if (typeof onProgress === "function") {
      try { onProgress({ stage, wallet: target, ...detail }); } catch (_) {}
    }
  };

  publish("discovering-communities");
  const discovery = await discoverWildLedgerCommunities({ force });

  publish("reading-wallet");
  const walletData = await readWalletLedgerData({
    wallet: target,
    serverUrl,
    issuer,
    currency
  });

  const warnings = [...(Array.isArray(discovery?.warnings) ? discovery.warnings : [])];
  if (walletData.linesError) warnings.push(`LEAP balance: ${walletData.linesError}`);

  let operatorJourney = { state: "UNKNOWN", request: null, community: null, transferredCommunity: null, currentCommunityCount: 0, initialCommunityCount: 0 };
  try {
    publish("reading-community-request");
    operatorJourney = compactOperatorJourney(
      await readCommunityRequestStatus({
        serverUrl,
        account: target,
        force
      })
    );
  } catch (error) {
    warnings.push(`Community request status: ${error?.message || String(error)}`);
  }

  const cashedCheckAmounts = buildCashedCheckAmounts(walletData.entries, issuer, currency);
  const relationships = [];
  const communities = Array.isArray(discovery?.communities) ? discovery.communities : [];

  for (let index = 0; index < communities.length; index += 1) {
    const discovered = communities[index];
    const communityId = String(discovered?.communityId || "").trim().toUpperCase();

    publish("reading-community", {
      communityId,
      index,
      total: communities.length
    });

    // Reference/demo communities are presentation examples, not canonical
    // Wild Ledger communities, so they do not become wallet relationships.
    if (!discovered?.canonical) continue;

    const community = communityObjectFromDiscovery(discovered);
    let authority = null;
    let catalog = null;

    try {
      authority = await resolveCommunityAuthority({ community, serverUrl, force });
    } catch (error) {
      warnings.push(`${communityId} authority: ${error?.message || String(error)}`);
    }

    if (authority?.authorityEstablished) {
      try {
        catalog = await loadRecognitionCatalog({
          community,
          serverUrl,
          issuer,
          currency,
          force,
          includeIgnored: true
        });
      } catch (error) {
        warnings.push(`${communityId} recognition: ${error?.message || String(error)}`);
      }
    }

    const relationship = summarizeCommunityRelationship({
      discovered,
      community,
      wallet: target,
      authority,
      catalog,
      entries: walletData.entries,
      cashedCheckAmounts,
      issuer,
      currency,
      legacyDistributors
    });

    // Keep only communities that have an actual ledger-backed relationship
    // with this wallet. Historical Operator is retained in the record for later
    // service-history uses, while the future ticker can choose active roles only.
    if (relationship.member || relationship.currentOperator || relationship.historicalOperator) {
      relationships.push(relationship);
    }
  }

  // Translate the raw request/provisioning state into the Operator journey
  // milestone Wild Ledger can present. XRPL still supplies the underlying facts.
  if (String(operatorJourney?.state || "").toUpperCase() === "READY") {
    const journeyCommunityId = String(operatorJourney?.community?.communityId || "").trim().toUpperCase();
    const relationship = relationships.find(item =>
      String(item?.communityId || "").trim().toUpperCase() === journeyCommunityId
      && item?.currentOperator
    );

    if (relationship) {
      operatorJourney = {
        ...operatorJourney,
        state: relationship.setupRequired ? "SETUP_REQUIRED" : (relationship.configured ? "OPERATIONAL" : "READY"),
        community: {
          ...(operatorJourney.community || {}),
          communityName: String(relationship.communityName || journeyCommunityId || "Community"),
          configured: Boolean(relationship.configured),
          setupRequired: Boolean(relationship.setupRequired)
        }
      };
    }
  }

  const ownerState = discovery?.ownerState || null;
  const record = {
    version: WILD_LEDGER_COMMUNITY_RECORD_VERSION,
    wallet: target,
    builtAt: new Date().toISOString(),
    leapBalance: walletData.leapBalance,
    isWildLedgerOwner: String(ownerState?.currentAccount || "") === target,
    operatorJourney,
    communities: relationships,
    warnings
  };

  // Do not let a slow background scan overwrite a newer wallet session.
  const stillActive = normalizeWallet(sessionGet(WILD_LEDGER_ACTIVE_WALLET_KEY));
  if (stillActive === target) {
    sessionSet(WILD_LEDGER_COMMUNITY_RECORD_KEY, JSON.stringify(record));
  }

  publish("complete", { record });
  return record;
}

export async function ensureWildLedgerCommunityRecord({
  wallet,
  force = false,
  onProgress = null
} = {}) {
  const target = normalizeWallet(wallet || sessionGet(WILD_LEDGER_ACTIVE_WALLET_KEY));
  if (!target) throw new Error("A valid active XRPL wallet is required.");

  if (!force) {
    const cached = getCachedWildLedgerCommunityRecord(target);
    if (cached) return cached;
  }

  if (IN_FLIGHT.has(target)) return IN_FLIGHT.get(target);

  const task = buildWildLedgerCommunityRecord({ wallet: target, force, onProgress })
    .finally(() => IN_FLIGHT.delete(target));

  IN_FLIGHT.set(target, task);
  return task;
}
