/*
  Wild Ledger public visibility — XRPL-backed application state.

  This is NOT LEAP Protocol state.
  Canonical community existence/authority still comes from LEAP Protocol + XRPL.
  Wild Ledger uses Owner-signed no-op AccountSet transactions only to decide
  whether a discovered community is presented on the public splash page.

  Canonical application memo:
    WILD-LEDGER/VISIBILITY/<COMMUNITY-ID>=HIDDEN
    WILD-LEDGER/VISIBILITY/<COMMUNITY-ID>=VISIBLE

  Visibility rule:
    no valid statement => visible
    latest valid statement VISIBLE => visible
    latest valid statement HIDDEN => hidden
*/

import {
  DirectXRPLClient,
  prepareNoOpAccountSet,
  submitSignedTransaction
} from "./xrplTransport.js";
import {
  resolveOwnerAuthority,
  clearOwnerAuthorityCache,
  isCanonicalNoOpAccountSet
} from "./ownerAuthority.js";

export const VISIBILITY_PREFIX = "WILD-LEDGER/VISIBILITY/";

const CACHE = new Map();

function normalizeCommunityId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)) {
    throw new Error("A valid Wild Ledger Community ID is required.");
  }
  return id;
}

function cloneState(state) {
  return {
    ...state,
    visibility: new Map([...state.visibility.entries()].map(([key, value]) => [key, { ...value }])),
    records: state.records.map(record => ({ ...record })),
    ownerState: JSON.parse(JSON.stringify(state.ownerState))
  };
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

function orderOf(value) {
  const rawIndex = value?.txIndex;
  return {
    ledger: Number(value?.ledger),
    txIndex: rawIndex !== null && rawIndex !== undefined && Number.isFinite(Number(rawIndex))
      ? Number(rawIndex)
      : null
  };
}

function compareOrder(a, b) {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const ai = Number.isFinite(a.txIndex) ? a.txIndex : -1;
  const bi = Number.isFinite(b.txIndex) ? b.txIndex : -1;
  return ai - bi;
}

function strictlyAfter(a, b) {
  return compareOrder(a, b) > 0;
}

function strictlyBefore(a, b) {
  return compareOrder(a, b) < 0;
}

function hexToText(value) {
  if (!value || typeof value !== "string") return "";
  if (!/^[A-Fa-f0-9]+$/.test(value) || value.length % 2 !== 0) return value;
  try {
    const pairs = value.match(/.{2}/g) || [];
    const bytes = new Uint8Array(pairs.map(pair => parseInt(pair, 16)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0+$/g, "");
  } catch (_) {
    return value;
  }
}

function decodedMemoTexts(tx) {
  const texts = [];
  for (const wrapper of Array.isArray(tx?.Memos) ? tx.Memos : []) {
    const memo = wrapper?.Memo || {};
    for (const field of [memo.MemoData, memo.MemoType, memo.MemoFormat]) {
      if (field === undefined || field === null || field === "") continue;
      const decoded = hexToText(field).trim();
      if (decoded) texts.push(decoded);
    }
  }
  return texts;
}

export function communityVisibilityMemo(communityId, hidden) {
  const id = normalizeCommunityId(communityId);
  return `${VISIBILITY_PREFIX}${id}=${hidden ? "HIDDEN" : "VISIBLE"}`;
}

function parseVisibilityRecord(entry) {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx)) return null;
  if (!tx?.Account) return null;

  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;
  const memo = texts[0];
  const match = memo.match(/^WILD-LEDGER\/VISIBILITY\/([A-Z0-9]+(?:-[A-Z0-9]+)*)=(HIDDEN|VISIBLE)$/);
  if (!match) return null;

  const communityId = match[1];
  const hidden = match[2] === "HIDDEN";
  if (memo !== communityVisibilityMemo(communityId, hidden)) return null;

  const ledger = ledgerIndex(entry, tx);
  if (!Number.isFinite(ledger)) return null;

  return {
    account: String(tx.Account),
    communityId,
    hidden,
    state: hidden ? "HIDDEN" : "VISIBLE",
    ledger,
    txIndex: transactionIndex(entry),
    hash: transactionHash(entry, tx),
    memo
  };
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

function ownerIntervals(ownerState) {
  if (!ownerState?.authorityEstablished || !ownerState.initialStatement) return [];
  const transitions = Array.isArray(ownerState.transitions) ? ownerState.transitions : [];
  const intervals = [];

  let account = ownerState.initialOwner;
  let start = orderOf(ownerState.initialStatement);

  for (const transition of transitions) {
    const end = orderOf(transition);
    intervals.push({ account, start, end });
    account = transition.to;
    start = end;
  }

  intervals.push({ account, start, end: null });
  return intervals;
}

function recordIsHistoricallyAuthorized(record, intervals) {
  const interval = intervals.find(item => item.account === record.account &&
    strictlyAfter(orderOf(record), item.start) &&
    (!item.end || strictlyBefore(orderOf(record), item.end))
  );
  return Boolean(interval);
}

function sortRecords(records) {
  const sorted = [...records].sort((a, b) => compareOrder(orderOf(a), orderOf(b)));
  for (let i = 1; i < sorted.length; i += 1) {
    const prior = sorted[i - 1];
    const current = sorted[i];
    if (prior.ledger === current.ledger && (!Number.isFinite(prior.txIndex) || !Number.isFinite(current.txIndex))) {
      throw new Error(`Visibility history needs XRPL transaction ordering for ledger ${current.ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

export async function readCommunityVisibility({ serverUrl, force = false } = {}) {
  const server = String(serverUrl || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!force && CACHE.has(server)) return cloneState(CACHE.get(server));

  if (force) clearOwnerAuthorityCache();
  const ownerState = await resolveOwnerAuthority({ serverUrl: server, force });
  if (!ownerState?.authorityEstablished) {
    throw new Error("Canonical Wild Ledger Owner authority is not established.");
  }

  const intervals = ownerIntervals(ownerState);
  const accounts = [...new Set(intervals.map(item => item.account).filter(Boolean))];
  const client = new DirectXRPLClient(server);
  const records = [];

  try {
    await client.connect();
    for (const account of accounts) {
      const rows = await readAccountHistory(client, account);
      for (const row of rows) {
        const record = parseVisibilityRecord(row);
        if (!record || record.account !== account) continue;
        if (!recordIsHistoricallyAuthorized(record, intervals)) continue;
        records.push(record);
      }
    }
  } finally {
    client.close();
  }

  const sorted = sortRecords(records);
  const visibility = new Map();
  for (const record of sorted) {
    visibility.set(record.communityId, {
      hidden: record.hidden,
      state: record.state,
      ownerWallet: record.account,
      ledger: record.ledger,
      txIndex: record.txIndex,
      hash: record.hash,
      memo: record.memo
    });
  }

  const state = {
    ownerState,
    visibility,
    records: sorted,
    resolvedAt: new Date().toISOString()
  };
  CACHE.set(server, state);
  return cloneState(state);
}

export function communityIsHidden(visibilityState, communityId) {
  const id = normalizeCommunityId(communityId);
  const map = visibilityState instanceof Map ? visibilityState : visibilityState?.visibility;
  return Boolean(map?.get?.(id)?.hidden);
}

export async function prepareCommunityVisibility({
  serverUrl,
  communityId,
  hidden,
  feeCushion = 1.2
} = {}) {
  const server = String(serverUrl || "").trim();
  const id = normalizeCommunityId(communityId);
  if (!server) throw new Error("XRPL WebSocket URL is required.");

  clearOwnerAuthorityCache();
  const ownerState = await resolveOwnerAuthority({ serverUrl: server, force: true });
  if (!ownerState?.authorityEstablished || !ownerState.currentAccount) {
    throw new Error("Canonical Wild Ledger Owner authority is not established.");
  }

  const memoText = communityVisibilityMemo(id, Boolean(hidden));
  const prepared = await prepareNoOpAccountSet({
    serverUrl: server,
    account: ownerState.currentAccount,
    memoText,
    feeCushion
  });

  return {
    ...prepared,
    ownerAccount: ownerState.currentAccount,
    communityId: id,
    hidden: Boolean(hidden),
    memoText
  };
}

export async function submitCommunityVisibility({
  serverUrl,
  signedBlob,
  expectedOwner,
  communityId,
  hidden,
  onSubmitted = null
} = {}) {
  const server = String(serverUrl || "").trim();
  const id = normalizeCommunityId(communityId);
  const expected = String(expectedOwner || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!expected) throw new Error("The prepared Owner Wallet is required.");

  clearOwnerAuthorityCache();
  const before = await resolveOwnerAuthority({ serverUrl: server, force: true });
  if (!before?.authorityEstablished || before.currentAccount !== expected) {
    throw new Error("Owner authority changed after preparation. Prepare a new visibility transaction.");
  }

  const result = await submitSignedTransaction({
    serverUrl: server,
    signedBlob,
    onSubmitted
  });
  if (result.finalResult !== "tesSUCCESS") {
    throw new Error(`Validated visibility transaction returned ${result.finalResult}.`);
  }

  CACHE.delete(server);
  clearOwnerAuthorityCache();
  const after = await readCommunityVisibility({ serverUrl: server, force: true });
  const record = after.visibility.get(id) || null;
  if (!record || record.hidden !== Boolean(hidden)) {
    throw new Error("The transaction validated, but Wild Ledger did not reconstruct the expected visibility state.");
  }

  return { result, visibilityState: after, record };
}

export function clearCommunityVisibilityCache() {
  CACHE.clear();
}
