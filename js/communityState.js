/*
  Wild Ledger community application STATE on XRPL.

  Generic STATE grammar:
    WILD-LEDGER/STATE/<COMMUNITY-ID>/<KEY>=<VALUE>

  Complete CONFIG Schema 1 grammar:
    WILD-LEDGER/STATE/<COMMUNITY-ID>/CONFIG=1|<COMPACT-JSON>

  CONFIG is not a pointer. The complete compact community configuration is in
  the validated transaction itself. The latest valid CONFIG signed by the
  Community Operating Wallet that was authoritative at that ledger position is
  the current configuration.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";
import { isCanonicalNoOpAccountSet } from "./communityAuthority.js";
import {
  COMMUNITY_CONFIG_SCHEMA,
  canonicalCommunityId,
  encodeCommunityConfigV1Compact,
  decodeCommunityConfigV1Compact
} from "./communityConfigSchema.js";

export const WILD_LEDGER_STATE_PREFIX = "WILD-LEDGER/STATE/";
export const XRPL_MEMOS_MAX_SERIALIZED_BYTES = 1024;

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

// XRPL variable-length prefix used by the MemoData Blob.
function variableLengthPrefixBytes(length) {
  const size = Number(length);
  if (!Number.isInteger(size) || size < 0) throw new Error("Invalid MemoData byte length.");
  if (size <= 192) return 1;
  if (size <= 12480) return 2;
  if (size <= 918744) return 3;
  throw new Error("MemoData is too large for XRPL variable-length encoding.");
}

/*
  One Memos array containing one Memo object containing only MemoData serializes
  with five fixed bytes plus MemoData's variable-length prefix:
    Memos field + Memo object field + MemoData field + object end + array end.
*/
export function oneMemoDataSerializedBytes(text) {
  const dataBytes = utf8ByteLength(text);
  return dataBytes + variableLengthPrefixBytes(dataBytes) + 5;
}

export function communityStateMemo(communityId, key, value) {
  const id = canonicalCommunityId(communityId);
  const stateKey = String(key || "").trim().toUpperCase();
  const stateValue = String(value ?? "").trim();
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(stateKey)) throw new Error("STATE key is not canonical.");
  if (!stateValue) throw new Error("STATE value is required.");
  return `${WILD_LEDGER_STATE_PREFIX}${id}/${stateKey}=${stateValue}`;
}

export function communityConfigMemo(config, { communityId = "" } = {}) {
  const compact = encodeCommunityConfigV1Compact(config, { communityId });
  const prefix = `${WILD_LEDGER_STATE_PREFIX}${compact.communityId}/CONFIG=${COMMUNITY_CONFIG_SCHEMA}|`;
  const memoText = `${prefix}${compact.text}`;
  const memoTextBytes = utf8ByteLength(memoText);
  const serializedMemosBytes = oneMemoDataSerializedBytes(memoText);
  const headroomBytes = XRPL_MEMOS_MAX_SERIALIZED_BYTES - serializedMemosBytes;

  if (serializedMemosBytes > XRPL_MEMOS_MAX_SERIALIZED_BYTES) {
    throw new Error(
      `CONFIG is ${serializedMemosBytes} serialized memo bytes, exceeding XRPL's ${XRPL_MEMOS_MAX_SERIALIZED_BYTES}-byte Memos limit by ${-headroomBytes} bytes.`
    );
  }

  return {
    ...compact,
    memoText,
    memoTextBytes,
    serializedMemosBytes,
    headroomBytes
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
  return String(entry?.hash || entry?.tx_hash || tx?.hash || "").toUpperCase();
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

function isAtOrBefore(a, b) {
  return compareOrder(a, b) <= 0;
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

function singleMemoDataText(tx) {
  const memos = Array.isArray(tx?.Memos) ? tx.Memos : [];
  if (memos.length !== 1) return "";
  const memo = memos[0]?.Memo || {};
  if (!memo.MemoData || memo.MemoType || memo.MemoFormat) return "";
  return hexToText(memo.MemoData);
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

function authorityCommunityId(authority) {
  const direct = String(authority?.communityId || "").trim();
  if (direct) return canonicalCommunityId(direct);
  const namespace = String(authority?.namespace || "").trim().toUpperCase();
  const match = namespace.match(/^([A-Z0-9][A-Z0-9-]*)-LEAP$/);
  if (!match) throw new Error("Community ID could not be derived from authority state.");
  return canonicalCommunityId(match[1]);
}

function authorityIntervals(authority) {
  const source = Array.isArray(authority?.authorityIntervals)
    ? authority.authorityIntervals
    : (Array.isArray(authority?.intervals) ? authority.intervals : []);
  return source.map(interval => ({
    account: String(interval?.account || ""),
    fromExclusive: interval?.fromExclusive || null,
    throughInclusive: interval?.throughInclusive || null
  })).filter(interval => isClassicAddress(interval.account));
}

function recordAuthorized(record, intervals) {
  return intervals.some(interval =>
    interval.account === record.account &&
    (!interval.fromExclusive || isAfter(record, interval.fromExclusive)) &&
    (!interval.throughInclusive || isAtOrBefore(record, interval.throughInclusive))
  );
}

function parseConfigRecord(entry, communityId) {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;

  const text = singleMemoDataText(tx);
  if (!text) return null;

  const prefix = `${WILD_LEDGER_STATE_PREFIX}${communityId}/CONFIG=`;
  if (!text.startsWith(prefix)) return null;

  const remainder = text.slice(prefix.length);
  const separator = remainder.indexOf("|");
  // Legacy pointer-only CONFIG=1 statements are deliberately ignored. A valid
  // current CONFIG must carry the complete compact payload in the same memo.
  if (separator <= 0) return null;

  const schemaText = remainder.slice(0, separator);
  if (!/^[1-9][0-9]*$/.test(schemaText)) return null;
  const schema = Number(schemaText);
  if (schema !== COMMUNITY_CONFIG_SCHEMA) return null;

  const payloadText = remainder.slice(separator + 1);
  if (!payloadText) return null;

  let config;
  try { config = decodeCommunityConfigV1Compact(payloadText, { communityId }); }
  catch (_) { return null; }

  // Re-encode to reject non-canonical alternate encodings that happen to
  // decode to the same object.
  let canonical;
  try { canonical = communityConfigMemo(config, { communityId }); }
  catch (_) { return null; }
  if (canonical.memoText !== text) return null;

  const order = orderFromEntry(entry, tx);
  if (!order) return null;

  return {
    communityId,
    schema,
    config,
    account: String(tx.Account),
    ledger: order.ledger,
    txIndex: order.txIndex,
    hash: transactionHash(entry, tx),
    memo: text,
    payloadText,
    payloadBytes: canonical.bytes,
    memoTextBytes: canonical.memoTextBytes,
    serializedMemosBytes: canonical.serializedMemosBytes,
    headroomBytes: canonical.headroomBytes
  };
}

function sortRecords(records) {
  const sorted = [...records].sort((a, b) => compareOrder(a, b));
  for (let index = 1; index < sorted.length; index += 1) {
    const prior = sorted[index - 1];
    const current = sorted[index];
    if (prior.ledger === current.ledger && (!Number.isFinite(prior.txIndex) || !Number.isFinite(current.txIndex))) {
      throw new Error(`CONFIG reconstruction needs XRPL transaction ordering for ledger ${current.ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

export async function readCommunityConfig({ authority, serverUrl } = {}) {
  if (!authority) throw new Error("Community authority is required to read CONFIG.");
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required to read CONFIG.");

  const communityId = authorityCommunityId(authority);
  const intervals = authorityIntervals(authority);
  const accounts = [...new Set(intervals.map(interval => interval.account))];
  if (!accounts.length) throw new Error("No Community Operating Wallet authority intervals are available for CONFIG reconstruction.");

  const client = new DirectXRPLClient(serverUrl);
  const records = [];
  try {
    await client.connect();
    for (const account of accounts) {
      const rows = await readAccountHistory(client, account);
      for (const row of rows) {
        const record = parseConfigRecord(row, communityId);
        if (!record || record.account !== account) continue;
        if (!recordAuthorized(record, intervals)) continue;
        records.push(record);
      }
    }
  } finally {
    client.close();
  }

  const sorted = sortRecords(records);
  return {
    communityId,
    schema: sorted.length ? sorted[sorted.length - 1].schema : null,
    records: sorted,
    current: sorted.length ? sorted[sorted.length - 1] : null,
    resolvedAt: new Date().toISOString()
  };
}

// Compatibility name used by the Step 4 pages. It now reconstructs the actual
// complete CONFIG, not a schema pointer.
export async function readCommunityConfigSchema(options = {}) {
  return readCommunityConfig(options);
}
