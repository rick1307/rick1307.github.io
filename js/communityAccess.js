/*
  Wild Ledger wallet-to-workspace access resolver.

  Purpose:
  - Accept the XRPL classic address returned by the live wallet connection.
  - Read validated XRPL Owner/community authority state.
  - Determine whether that address is the current Wild Ledger Owner Wallet and/or
    the current Operating Wallet for one or more canonical communities.

  This module does not authenticate a person, request a signature, construct a
  transaction, or write XRPL. The connected wallet address is the application
  ingress value; XRPL authority history determines its current Wild Ledger role.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";
import { resolveOwnerAuthority } from "./ownerAuthority.js";
import {
  resolveCommunityAuthority,
  isCanonicalNoOpAccountSet,
  operatingWalletMemo
} from "./communityAuthority.js";

function normalizeTx(entry) {
  return entry?.tx_json || entry?.tx || entry?.transaction || entry || {};
}

function txSucceeded(entry) {
  if (entry?.validated === false) return false;
  const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
  const result = meta?.TransactionResult ?? meta?.transaction_result;
  return !result || result === "tesSUCCESS";
}

function ledgerIndex(entry, tx = normalizeTx(entry)) {
  const value = entry?.ledger_index ?? entry?.ledgerIndex ?? tx?.ledger_index ?? tx?.ledgerIndex ?? tx?.inLedger;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transactionIndex(entry) {
  const meta = entry?.meta || entry?.metaData || entry?.metadata || {};
  const value = entry?.tx_index ?? entry?.transaction_index ?? meta?.TransactionIndex ?? meta?.transaction_index;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transactionHash(entry, tx = normalizeTx(entry)) {
  return String(entry?.hash || entry?.tx_hash || tx?.hash || "");
}

function orderFromEntry(entry, tx = normalizeTx(entry)) {
  const ledger = ledgerIndex(entry, tx);
  return Number.isFinite(ledger) ? { ledger, txIndex: transactionIndex(entry) } : null;
}

function compareOrder(a, b) {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const ai = Number.isFinite(a.txIndex) ? a.txIndex : -1;
  const bi = Number.isFinite(b.txIndex) ? b.txIndex : -1;
  return ai - bi;
}

function isAfter(a, b) {
  return compareOrder(a, b) > 0;
}

function hexToUtf8(hex) {
  const clean = String(hex || "").replace(/[^A-Fa-f0-9]/g, "");
  if (!clean || clean.length % 2) return "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  try { return new TextDecoder().decode(bytes); } catch (_) { return ""; }
}

function decodedMemoTexts(tx) {
  const out = [];
  for (const wrapper of Array.isArray(tx?.Memos) ? tx.Memos : []) {
    const memo = wrapper?.Memo || {};
    for (const field of [memo.MemoData, memo.MemoType, memo.MemoFormat]) {
      if (field === undefined || field === null || field === "") continue;
      const text = hexToUtf8(field).trim();
      if (text) out.push(text);
    }
  }
  return out;
}

async function readAccountHistory(client, account) {
  let marker;
  const rows = [];
  do {
    const fields = {
      account,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: false,
      forward: true,
      limit: 400
    };
    if (marker !== undefined) fields.marker = marker;
    const response = await client.request("account_tx", fields, 30000);
    const result = response.result || {};
    rows.push(...(Array.isArray(result.transactions) ? result.transactions : []));
    marker = result.marker;
  } while (marker !== undefined && marker !== null);
  return rows;
}

function authorityStatementFromEntry(entry, namespace) {
  const tx = normalizeTx(entry);
  if (!txSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;

  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;

  const prefix = `${namespace}/AUTHORITY/OPERATING-WALLET=`;
  const text = texts[0];
  if (!text.startsWith(prefix)) return null;

  const value = text.slice(prefix.length);
  if (!isClassicAddress(value) || text !== operatingWalletMemo(namespace, value)) return null;

  const order = orderFromEntry(entry, tx);
  if (!order) return null;

  return {
    account: String(tx.Account),
    value,
    ledger: order.ledger,
    txIndex: order.txIndex,
    hash: transactionHash(entry, tx),
    memo: text
  };
}

function sortOrdered(rows, label) {
  const sorted = [...rows].sort((a, b) => compareOrder(a, b));
  for (let index = 1; index < sorted.length; index += 1) {
    if (
      sorted[index - 1].ledger === sorted[index].ledger &&
      (!Number.isFinite(sorted[index - 1].txIndex) || !Number.isFinite(sorted[index].txIndex))
    ) {
      throw new Error(`${label} needs XRPL transaction ordering for ledger ${sorted[index].ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

async function resolveProvisionedCommunityAuthority(client, provision, maxTransitions = 50) {
  const communityId = String(provision?.communityId || "").trim().toUpperCase();
  const namespace = String(provision?.namespace || `${communityId}-LEAP`).trim().toUpperCase();
  const firstWallet = String(provision?.operatingWallet || "").trim();
  if (!communityId || !namespace || !isClassicAddress(firstWallet)) {
    throw new Error("Owner provisioning record is incomplete.");
  }

  const provisionLedger = Number(provision?.ledger);
  if (!Number.isFinite(provisionLedger)) throw new Error(`${communityId} provisioning ledger is unavailable.`);

  let currentAccount = firstWallet;
  let activeFromExclusive = {
    ledger: provisionLedger,
    txIndex: Number.isFinite(Number(provision?.txIndex)) ? Number(provision.txIndex) : null
  };

  const accounts = [currentAccount];
  const transitions = [];
  const statements = [];
  const intervals = [];
  const statementCache = new Map();
  const seen = new Set([currentAccount]);
  let intervalStart = activeFromExclusive;
  let transitionCount = 0;

  async function statementsFor(account) {
    if (statementCache.has(account)) return statementCache.get(account);
    const rows = await readAccountHistory(client, account);
    const parsed = sortOrdered(
      rows.map(row => authorityStatementFromEntry(row, namespace)).filter(Boolean),
      "Authority history"
    );
    statementCache.set(account, parsed);
    return parsed;
  }

  while (transitionCount < maxTransitions) {
    const candidates = (await statementsFor(currentAccount)).filter(statement =>
      statement.account === currentAccount &&
      isAfter({ ledger: statement.ledger, txIndex: statement.txIndex }, activeFromExclusive)
    );

    let rotation = null;
    for (const candidate of candidates) {
      statements.push({ ...candidate, kind: candidate.value === currentAccount ? "REAFFIRM" : "ROTATION" });
      activeFromExclusive = { ledger: candidate.ledger, txIndex: candidate.txIndex };
      if (candidate.value !== currentAccount) {
        rotation = candidate;
        break;
      }
    }

    if (!rotation) {
      intervals.push({
        account: currentAccount,
        fromExclusive: intervalStart,
        throughInclusive: null
      });
      break;
    }

    intervals.push({
      account: currentAccount,
      fromExclusive: intervalStart,
      throughInclusive: { ledger: rotation.ledger, txIndex: rotation.txIndex }
    });

    transitions.push({
      from: currentAccount,
      to: rotation.value,
      ledger: rotation.ledger,
      txIndex: rotation.txIndex,
      hash: rotation.hash,
      memo: rotation.memo
    });

    if (seen.has(rotation.value)) throw new Error(`${communityId} authority history contains a rotation loop.`);
    currentAccount = rotation.value;
    seen.add(currentAccount);
    accounts.push(currentAccount);
    intervalStart = { ledger: rotation.ledger, txIndex: rotation.txIndex };
    transitionCount += 1;
  }

  if (transitionCount >= maxTransitions) {
    throw new Error(`${communityId} authority state exceeded the ${maxTransitions}-rotation safety limit.`);
  }

  return {
    communityId,
    namespace,
    currentAccount,
    accounts,
    statements,
    transitions,
    intervals,
    establishment: {
      ownerWallet: String(provision?.ownerWallet || ""),
      firstWallet,
      ledger: provision.ledger,
      txIndex: provision.txIndex,
      hash: String(provision?.hash || ""),
      memo: String(provision?.memo || "")
    }
  };
}

function backendIdFor(community) {
  return String(
    window.WILD_LEDGER_BACKEND_COMMUNITY_ID?.(community) ||
    community?.backendId ||
    community?.id ||
    ""
  ).trim().toUpperCase();
}

function normalizeIntervals(authority) {
  return (authority?.intervals || [])
    .map(interval => ({
      account: String(interval?.account || ""),
      fromExclusive: interval?.fromExclusive || null,
      throughInclusive: interval?.throughInclusive || null
    }))
    .filter(interval => isClassicAddress(interval.account));
}

export async function resolveWalletAccess({ account, serverUrl, force = true } = {}) {
  const target = String(account || "").trim();
  if (!isClassicAddress(target)) throw new Error("The connected wallet did not return a valid XRPL classic address.");
  if (!serverUrl) throw new Error("XRPL WebSocket server is not configured.");

  const ownerState = await resolveOwnerAuthority({ serverUrl, force });
  if (!ownerState?.authorityEstablished) {
    throw new Error("Canonical Wild Ledger Owner authority is not established on XRPL.");
  }

  const matches = [];
  const evaluated = [];
  const provisionedIds = new Set();
  const client = new DirectXRPLClient(serverUrl);

  try {
    await client.connect();

    for (const provision of ownerState.provisionedCommunities || []) {
      const communityId = String(provision?.communityId || "").trim().toUpperCase();
      if (!communityId) continue;
      provisionedIds.add(communityId);

      const state = await resolveProvisionedCommunityAuthority(client, provision);
      const configured = window.WILD_LEDGER_GET_COMMUNITY?.(communityId) || null;
      const record = {
        communityId,
        communityName: configured?.communityName || communityId,
        namespace: state.namespace,
        currentAccount: state.currentAccount,
        source: "Owner provisioning + community authority history",
        configured: Boolean(configured),
        establishment: state.establishment,
        transitions: state.transitions,
        authorityAccounts: state.accounts,
        authorityIntervals: state.intervals
      };

      evaluated.push(record);
      if (record.currentAccount === target) matches.push(record);
    }
  } finally {
    client.close();
  }

  const registry = window.WILD_LEDGER_COMMUNITY_REGISTRY || {};
  for (const community of Object.values(registry)) {
    const communityId = backendIdFor(community);
    if (!communityId || provisionedIds.has(communityId) || community?.directoryTone === "reference") continue;

    const configuredWallet = String(community?.operatingWallet || "").trim();
    if (!isClassicAddress(configuredWallet)) continue;

    const authority = await resolveCommunityAuthority({ community, serverUrl, force });
    if (!authority?.authorityEstablished) continue;

    const record = {
      communityId,
      communityName: community?.communityName || communityId,
      namespace: authority.namespace || community?.leapNamespace || `${communityId}-LEAP`,
      currentAccount: authority.currentAccount || authority.canonicalCurrentAccount || "",
      source: "Existing-community canonical authority history",
      configured: true,
      establishment: authority.initialStatement || null,
      transitions: authority.transitions || [],
      authorityAccounts: authority.accounts || [],
      authorityIntervals: normalizeIntervals(authority)
    };

    evaluated.push(record);
    if (record.currentAccount === target) matches.push(record);
  }

  const ownerWallet = String(ownerState.currentAccount || ownerState.canonicalCurrentAccount || "");
  return {
    connectedAccount: target,
    isOwner: ownerWallet === target,
    ownerWallet,
    operatorMatches: matches,
    evaluated,
    resolvedAt: new Date().toISOString()
  };
}
