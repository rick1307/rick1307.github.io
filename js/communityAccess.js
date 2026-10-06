/*
  Wild Ledger wallet-address router.

  One wallet connection supplies an XRPL classic address. This module reads
  validated XRPL authority history and answers whether that address is:
    - the current Wild Ledger Owner Wallet;
    - the current Operating Wallet for one or more communities.

  No app username, password, Access ID, or private wallet material is used.
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

function transactionSucceeded(entry) {
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
  if (!Number.isFinite(ledger)) return null;
  return { ledger, txIndex: transactionIndex(entry) };
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

function hexToText(value) {
  const hex = String(value || "");
  if (!hex || !/^[A-Fa-f0-9]+$/.test(hex) || hex.length % 2 !== 0) return "";
  try {
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(pair => parseInt(pair, 16)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0+$/g, "");
  } catch (_) {
    return "";
  }
}

function decodedMemoTexts(tx) {
  const out = [];
  for (const wrapper of Array.isArray(tx?.Memos) ? tx.Memos : []) {
    const memo = wrapper?.Memo || {};
    for (const field of [memo.MemoData, memo.MemoType, memo.MemoFormat]) {
      if (field === undefined || field === null || field === "") continue;
      const text = hexToText(field).trim();
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
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;
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
    const prior = sorted[index - 1];
    const current = sorted[index];
    if (prior.ledger === current.ledger && (!Number.isFinite(prior.txIndex) || !Number.isFinite(current.txIndex))) {
      throw new Error(`${label} needs XRPL transaction ordering for ledger ${current.ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

async function resolveProvisionedCommunityAuthority(client, provision, maxTransitions = 50) {
  const communityId = String(provision?.communityId || "").trim().toUpperCase();
  const namespace = String(provision?.namespace || `${communityId}-LEAP`).trim();
  const firstWallet = String(provision?.operatingWallet || "").trim();
  if (!communityId || !namespace || !isClassicAddress(firstWallet)) throw new Error("Owner provisioning record is incomplete.");

  const establishmentOrder = {
    ledger: Number(provision.ledger),
    txIndex: Number.isFinite(Number(provision.txIndex)) ? Number(provision.txIndex) : null
  };
  if (!Number.isFinite(establishmentOrder.ledger)) throw new Error(`${communityId} provisioning ledger is unavailable.`);

  let currentAccount = firstWallet;
  let activeFromExclusive = establishmentOrder;
  let intervalStart = establishmentOrder;
  const accounts = [firstWallet];
  const statements = [];
  const transitions = [];
  const intervals = [];
  const seen = new Set([firstWallet]);
  const cache = new Map();
  let transitionCount = 0;

  async function statementsFor(account) {
    if (cache.has(account)) return cache.get(account);
    const rows = await readAccountHistory(client, account);
    const parsed = sortOrdered(
      rows.map(row => authorityStatementFromEntry(row, namespace)).filter(Boolean),
      `${communityId} authority history`
    );
    cache.set(account, parsed);
    return parsed;
  }

  while (transitionCount < maxTransitions) {
    const candidates = (await statementsFor(currentAccount)).filter(statement =>
      statement.account === currentAccount && isAfter(statement, activeFromExclusive)
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
        source: "owner-provisioned",
        fromExclusive: intervalStart,
        throughInclusive: null,
        fromLedger: intervalStart.ledger,
        throughLedger: null
      });
      break;
    }

    const rotationOrder = { ledger: rotation.ledger, txIndex: rotation.txIndex };
    intervals.push({
      account: currentAccount,
      source: "owner-provisioned",
      fromExclusive: intervalStart,
      throughInclusive: rotationOrder,
      fromLedger: intervalStart.ledger,
      throughLedger: rotation.ledger
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
    intervalStart = rotationOrder;
    activeFromExclusive = rotationOrder;
    transitionCount += 1;
  }

  if (transitionCount >= maxTransitions) throw new Error(`${communityId} authority state exceeded the ${maxTransitions}-rotation safety limit.`);

  return {
    communityId,
    namespace,
    authorityEstablished: true,
    currentAccount,
    canonicalCurrentAccount: currentAccount,
    accounts,
    statements,
    transitions,
    intervals,
    establishment: {
      ownerWallet: String(provision.ownerWallet || ""),
      firstWallet,
      operatingWallet: firstWallet,
      ledger: provision.ledger,
      txIndex: provision.txIndex,
      hash: String(provision.hash || ""),
      memo: String(provision.memo || "")
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

function normalizedIntervals(authority) {
  return (authority?.intervals || []).map(interval => ({
    account: String(interval.account || ""),
    source: String(interval.source || "xrpl"),
    fromExclusive: interval.fromExclusive || null,
    throughInclusive: interval.throughInclusive || null,
    fromLedger: interval.fromLedger ?? null,
    throughLedger: interval.throughLedger ?? null
  })).filter(interval => isClassicAddress(interval.account));
}

function accessRecord({ communityId, configured, authority, source }) {
  return {
    communityId,
    communityName: configured?.communityName || communityId,
    namespace: authority.namespace || configured?.leapNamespace || `${communityId}-LEAP`,
    currentAccount: authority.currentAccount || authority.canonicalCurrentAccount || "",
    source,
    configured: Boolean(configured),
    authorityEstablished: Boolean(authority.authorityEstablished),
    authorityAccounts: [...(authority.accounts || [])],
    authorityIntervals: normalizedIntervals(authority),
    accounts: [...(authority.accounts || [])],
    intervals: normalizedIntervals(authority),
    transitions: [...(authority.transitions || [])],
    establishment: authority.establishment || {
      firstWallet: authority.initialStatement?.account || configured?.operatingWallet || "",
      operatingWallet: authority.initialStatement?.account || configured?.operatingWallet || "",
      ledger: authority.initialStatement?.ledger ?? null,
      txIndex: authority.initialStatement?.txIndex ?? null,
      hash: authority.initialStatement?.hash || "",
      memo: authority.initialStatement?.memo || ""
    }
  };
}

export async function resolveWalletAccess({ account, serverUrl, force = false } = {}) {
  const target = String(account || "").trim();
  if (!isClassicAddress(target)) throw new Error("The connected wallet is not a valid XRPL classic address.");
  if (!serverUrl) throw new Error("XRPL WebSocket server is not configured.");

  const ownerState = await resolveOwnerAuthority({ serverUrl, force });
  if (!ownerState?.authorityEstablished) throw new Error("Canonical Wild Ledger Owner authority is not established on XRPL.");

  const currentOwner = String(ownerState.currentAccount || ownerState.canonicalCurrentAccount || "");
  const registry = window.WILD_LEDGER_COMMUNITY_REGISTRY || {};
  const configuredById = new Map();
  for (const community of Object.values(registry)) {
    const id = backendIdFor(community);
    if (id) configuredById.set(id, community);
  }

  const operatorMatches = [];
  const evaluated = [];
  const provisionedIds = new Set();

  const client = new DirectXRPLClient(serverUrl);
  try {
    await client.connect();
    for (const provision of ownerState.provisionedCommunities || []) {
      const communityId = String(provision?.communityId || "").trim().toUpperCase();
      if (!communityId) continue;
      provisionedIds.add(communityId);
      const authority = await resolveProvisionedCommunityAuthority(client, provision);
      const record = accessRecord({
        communityId,
        configured: configuredById.get(communityId) || null,
        authority,
        source: "Owner provisioning + community authority history"
      });
      evaluated.push(record);
      if (record.currentAccount === target) operatorMatches.push(record);
    }
  } finally {
    client.close();
  }

  for (const community of Object.values(registry)) {
    const communityId = backendIdFor(community);
    if (!communityId || provisionedIds.has(communityId) || community?.directoryTone === "reference") continue;
    const configuredWallet = String(community?.operatingWallet || "").trim();
    if (!isClassicAddress(configuredWallet)) continue;

    const authority = await resolveCommunityAuthority({ community, serverUrl, force });
    if (!authority?.authorityEstablished) continue;
    const record = accessRecord({
      communityId,
      configured: community,
      authority,
      source: "Existing-community canonical authority history"
    });
    evaluated.push(record);
    if (record.currentAccount === target) operatorMatches.push(record);
  }

  return {
    verifiedAccount: target,
    isOwner: currentOwner === target,
    ownerWallet: currentOwner,
    ownerState,
    operatorMatches,
    evaluated,
    resolvedAt: new Date().toISOString()
  };
}
