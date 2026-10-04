/*
  Wild Ledger Owner Authority resolver — proposed LEAP Protocol 1.0 authority model.

  Initial protocol anchor:
    r4ZJA28EzaTa3g1GvMqQ37WjwTmgwkEHRb

  Canonical Owner authority state:
    LEAP/AUTHORITY/OWNER-WALLET=<XRPL-ADDRESS>

  Brand-new community establishment by the current Owner Wallet:
    <COMMUNITY>-LEAP/AUTHORITY/OPERATING-WALLET=<XRPL-ADDRESS>

  This module reads validated XRPL history only. It never signs or submits.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";

export const PROTOCOL_INITIAL_OWNER_WALLET = "r4ZJA28EzaTa3g1GvMqQ37WjwTmgwkEHRb";
export const OWNER_AUTHORITY_PREFIX = "LEAP/AUTHORITY/OWNER-WALLET=";

const ACCOUNTSET_SPECIFIC_FIELDS = [
  "ClearFlag", "Domain", "EmailHash", "MessageKey", "NFTokenMinter",
  "SetFlag", "TransferRate", "TickSize", "WalletLocator", "WalletSize"
];

const CACHE = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  if (!value || typeof value !== "string") return "";
  if (!/^[A-Fa-f0-9]+$/.test(value) || value.length % 2 !== 0) return value;
  try {
    const bytes = new Uint8Array(value.match(/.{2}/g).map(pair => parseInt(pair, 16)));
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

export function isCanonicalNoOpAccountSet(tx) {
  if (tx?.TransactionType !== "AccountSet") return false;
  if (Number(tx.Flags || 0) !== 0) return false;
  return ACCOUNTSET_SPECIFIC_FIELDS.every(field => !(field in tx));
}

export function ownerWalletMemo(account) {
  const wallet = String(account || "").trim();
  if (!isClassicAddress(wallet)) throw new Error("A valid XRPL classic address is required for OWNER-WALLET.");
  return `${OWNER_AUTHORITY_PREFIX}${wallet}`;
}

export function communityOperatingWalletMemo(communityId, account) {
  const id = String(communityId || "").trim().toUpperCase();
  const wallet = String(account || "").trim();
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)) throw new Error("A valid canonical Community ID is required.");
  if (!isClassicAddress(wallet)) throw new Error("A valid XRPL classic address is required for OPERATING-WALLET.");
  return `${id}-LEAP/AUTHORITY/OPERATING-WALLET=${wallet}`;
}

function protocolRecordFromEntry(entry) {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;

  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;
  const memo = texts[0];
  const order = orderFromEntry(entry, tx);
  if (!order) return null;

  if (memo.startsWith(OWNER_AUTHORITY_PREFIX)) {
    const value = memo.slice(OWNER_AUTHORITY_PREFIX.length);
    if (!isClassicAddress(value) || memo !== ownerWalletMemo(value)) return null;
    return {
      kind: "OWNER",
      account: String(tx.Account),
      value,
      ledger: order.ledger,
      txIndex: order.txIndex,
      hash: transactionHash(entry, tx),
      memo
    };
  }

  const match = memo.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)*)-LEAP\/AUTHORITY\/OPERATING-WALLET=(r[1-9A-HJ-NP-Za-km-z]{24,34})$/);
  if (!match) return null;

  const communityId = match[1];
  const value = match[2];
  if (memo !== communityOperatingWalletMemo(communityId, value)) return null;

  return {
    kind: "PROVISION",
    account: String(tx.Account),
    communityId,
    namespace: `${communityId}-LEAP`,
    value,
    ledger: order.ledger,
    txIndex: order.txIndex,
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

function sortRecords(records) {
  const sorted = [...records].sort((a, b) => compareOrder(a, b));
  for (let i = 1; i < sorted.length; i += 1) {
    const prior = sorted[i - 1];
    const current = sorted[i];
    if (prior.ledger === current.ledger && (!Number.isFinite(prior.txIndex) || !Number.isFinite(current.txIndex))) {
      throw new Error(`Owner authority resolution needs XRPL transaction ordering for ledger ${current.ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

function recordOrder(record) {
  return { ledger: Number(record.ledger), txIndex: Number.isFinite(record.txIndex) ? Number(record.txIndex) : null };
}

export async function resolveOwnerAuthority({
  serverUrl,
  initialOwner = PROTOCOL_INITIAL_OWNER_WALLET,
  force = false,
  maxTransitions = 50
}) {
  const anchor = String(initialOwner || "").trim();
  if (!isClassicAddress(anchor)) throw new Error("The protocol initial Owner Wallet is not a valid XRPL classic address.");
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required.");

  const cacheKey = `${serverUrl}|${anchor}`;
  if (!force && CACHE.has(cacheKey)) return clone(CACHE.get(cacheKey));

  const client = new DirectXRPLClient(serverUrl);
  const recordCache = new Map();

  async function recordsFor(account) {
    if (recordCache.has(account)) return recordCache.get(account);
    const rows = await readAccountHistory(client, account);
    const records = sortRecords(rows.map(protocolRecordFromEntry).filter(Boolean));
    recordCache.set(account, records);
    return records;
  }

  try {
    await client.connect();

    const anchorRecords = await recordsFor(anchor);
    const initialStatement = anchorRecords.find(record =>
      record.kind === "OWNER" && record.account === anchor && record.value === anchor
    ) || null;

    if (!initialStatement) {
      const state = {
        authorityEstablished: false,
        initialOwner: anchor,
        currentAccount: anchor,
        canonicalCurrentAccount: "",
        initialStatement: null,
        accounts: [anchor],
        statements: [],
        transitions: [],
        provisionedCommunities: [],
        resolvedAt: new Date().toISOString()
      };
      CACHE.set(cacheKey, state);
      return clone(state);
    }

    const accounts = [anchor];
    const statements = [{ ...initialStatement, kindLabel: "INITIAL" }];
    const transitions = [];
    const provisionedCommunities = [];
    const establishedIds = new Set();
    const seenOwners = new Set([anchor]);

    let currentAccount = anchor;
    let activeFromExclusive = recordOrder(initialStatement);
    let transitionCount = 0;

    while (transitionCount < maxTransitions) {
      const records = (await recordsFor(currentAccount)).filter(record =>
        record.account === currentAccount && isAfter(recordOrder(record), activeFromExclusive)
      );

      let rotation = null;
      for (const record of records) {
        if (record.kind === "PROVISION") {
          if (!establishedIds.has(record.communityId)) {
            establishedIds.add(record.communityId);
            provisionedCommunities.push({
              communityId: record.communityId,
              namespace: record.namespace,
              operatingWallet: record.value,
              ownerWallet: currentAccount,
              ledger: record.ledger,
              txIndex: record.txIndex,
              hash: record.hash,
              memo: record.memo
            });
          }
          continue;
        }

        if (record.kind === "OWNER") {
          statements.push({
            ...record,
            kindLabel: record.value === currentAccount ? "REAFFIRM" : "ROTATION"
          });
          activeFromExclusive = recordOrder(record);
          if (record.value !== currentAccount) {
            rotation = record;
            break;
          }
        }
      }

      if (!rotation) break;

      transitions.push({
        from: currentAccount,
        to: rotation.value,
        ledger: rotation.ledger,
        txIndex: rotation.txIndex,
        hash: rotation.hash,
        memo: rotation.memo
      });

      if (seenOwners.has(rotation.value)) {
        throw new Error("Owner authority history contains a rotation loop.");
      }

      currentAccount = rotation.value;
      seenOwners.add(currentAccount);
      accounts.push(currentAccount);
      transitionCount += 1;
    }

    if (transitionCount >= maxTransitions) {
      throw new Error(`Owner authority state exceeded the ${maxTransitions}-rotation safety limit.`);
    }

    provisionedCommunities.sort((a, b) => compareOrder(a, b));

    const state = {
      authorityEstablished: true,
      initialOwner: anchor,
      currentAccount,
      canonicalCurrentAccount: currentAccount,
      initialStatement: { ...initialStatement },
      accounts,
      statements,
      transitions,
      provisionedCommunities,
      resolvedAt: new Date().toISOString()
    };

    CACHE.set(cacheKey, state);
    return clone(state);
  } finally {
    client.close();
  }
}

export function clearOwnerAuthorityCache() {
  CACHE.clear();
}
