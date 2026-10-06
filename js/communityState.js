/*
  Wild Ledger community STATE reader.

  Canonical application STATE memo form:
    WILD-LEDGER/STATE/<COMMUNITY-ID>/<KEY>=<VALUE>

  CONFIG specialization:
    WILD-LEDGER/STATE/<COMMUNITY-ID>/CONFIG=<SCHEMA>

  The CONFIG value identifies the technical CONFIG schema, not an off-ledger
  snapshot version. The complete current off-ledger CONFIG is keyed by Community ID.

  This module reads and reconstructs validated state only. It does not publish.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";
import { isCanonicalNoOpAccountSet } from "./communityAuthority.js";

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

function isAtOrBefore(a, b) {
  return compareOrder(a, b) <= 0;
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

function canonicalToken(value, label) {
  const token = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(token)) throw new Error(`${label} is not canonical uppercase letters/numbers/hyphen.`);
  return token;
}

export function communityStateMemo(communityId, key, value) {
  const id = canonicalToken(communityId, "Community ID");
  const stateKey = canonicalToken(key, "STATE key");
  const stateValue = String(value ?? "").trim();
  if (!stateValue) throw new Error("STATE value is required.");
  if(/[\r\n\u0000]/.test(stateValue)) throw new Error("STATE value contains unsupported control characters.");
  return `WILD-LEDGER/STATE/${id}/${stateKey}=${stateValue}`;
}

function parseStateRecord(entry, expectedCommunity, expectedKey, valueValidator) {
  const tx = normalizeTx(entry);
  if (!txSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;

  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;

  const id = canonicalToken(expectedCommunity, "Community ID");
  const key = canonicalToken(expectedKey, "STATE key");
  const prefix = `WILD-LEDGER/STATE/${id}/${key}=`;
  const text = texts[0];
  if (!text.startsWith(prefix)) return null;

  const value = text.slice(prefix.length);
  if (!value || text !== communityStateMemo(id, key, value)) return null;
  if (typeof valueValidator === "function" && !valueValidator(value)) return null;

  const order = orderFromEntry(entry, tx);
  if (!order) return null;

  return {
    communityId: id,
    key,
    value,
    account: String(tx.Account),
    ledger: order.ledger,
    txIndex: order.txIndex,
    hash: transactionHash(entry, tx),
    memo: text
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

function recordAuthorized(record, intervals) {
  return intervals.some(interval =>
    interval.account === record.account &&
    (!interval.fromExclusive || isAfter(record, interval.fromExclusive)) &&
    (!interval.throughInclusive || isAtOrBefore(record, interval.throughInclusive))
  );
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

export async function reconstructCommunityState({ authority, key, serverUrl, valueValidator = null } = {}) {
  if (!authority?.communityId) throw new Error("Community authority context is required.");
  if (!serverUrl) throw new Error("XRPL WebSocket server is required.");

  const intervals = Array.isArray(authority.authorityIntervals) ? authority.authorityIntervals : [];
  const accounts = [...new Set(
    (Array.isArray(authority.authorityAccounts) && authority.authorityAccounts.length
      ? authority.authorityAccounts
      : intervals.map(interval => interval?.account)
    ).filter(account => isClassicAddress(account))
  )];

  if (!accounts.length || !intervals.length) {
    throw new Error("Historical Community Operating Wallet authority intervals are unavailable.");
  }

  const client = new DirectXRPLClient(serverUrl);
  const records = [];
  try {
    await client.connect();
    for (const account of accounts) {
      const rows = await readAccountHistory(client, account);
      for (const row of rows) {
        const record = parseStateRecord(row, authority.communityId, key, valueValidator);
        if (!record || record.account !== account) continue;
        if (!recordAuthorized(record, intervals)) continue;
        records.push(record);
      }
    }
  } finally {
    client.close();
  }

  const sorted = sortOrdered(records, "Community STATE history");
  return {
    communityId: String(authority.communityId).trim().toUpperCase(),
    key: canonicalToken(key, "STATE key"),
    records: sorted,
    current: sorted.length ? sorted[sorted.length - 1] : null,
    resolvedAt: new Date().toISOString()
  };
}

export async function readCommunityConfigSchema({ authority, serverUrl } = {}) {
  const state = await reconstructCommunityState({
    authority,
    key: "CONFIG",
    serverUrl,
    valueValidator: value => /^[1-9][0-9]*$/.test(String(value || ""))
  });

  return {
    ...state,
    schema: state.current ? Number(state.current.value) : null
  };
}

// Temporary compatibility alias for Step 2 pages created before CONFIG=1 was
// locked as a schema marker. New code should use readCommunityConfigSchema().
export async function readCommunityConfigPointer(options = {}) {
  const state = await readCommunityConfigSchema(options);
  return { ...state, version: state.schema };
}
