/*
  Wild Ledger community Join Request Price — LEAP Protocol 0.24.
  Price is independent of CONFIG. Each valid Operator-authorized no-op
  AccountSet publishes one canonical price memo. No publication means 1 drop.
*/
import { DirectXRPLClient, textToHex, isClassicAddress } from "./xrplTransport.js";
import { isAuthorizedAtLedger, isCanonicalNoOpAccountSet } from "./communityAuthority.js";
import { canonicalCommunityId } from "./communityConfigSchema.js";

export const DEFAULT_JOIN_REQUEST_DROPS = "1";

export function canonicalJoinRequestDrops(value) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Join Request Price must be a positive whole number of drops.");
  return raw;
}

export function joinRequestPriceMemo(communityId, drops) {
  return `WILD-LEDGER/JOIN-REQUEST-PRICE-DROPS/${canonicalCommunityId(communityId)}=${canonicalJoinRequestDrops(drops)}`;
}

function decodeMemo(tx) {
  const memos = Array.isArray(tx?.Memos) ? tx.Memos : [];
  if (memos.length !== 1) return "";
  const memo = memos[0]?.Memo || {};
  if (memo.MemoType || memo.MemoFormat || !memo.MemoData) return "";
  const hex = String(memo.MemoData);
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return "";
  try {
    const bytes = Uint8Array.from(hex.match(/../g), part => Number.parseInt(part, 16));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) { return ""; }
}

function recordFromEntry(entry, communityId, authority) {
  if (entry?.validated !== true) return null;
  const tx = entry.tx_json || entry.tx || entry.transaction || {};
  if (!isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;
  const result = (entry.meta || entry.metaData || {}).TransactionResult;
  if (result !== "tesSUCCESS") return null;
  const index = Number(entry.ledger_index ?? tx.ledger_index);
  const txIndex = Number((entry.meta || entry.metaData || {}).TransactionIndex);
  if (!Number.isInteger(index) || !Number.isInteger(txIndex)) return null;
  if (!isAuthorizedAtLedger(authority, tx.Account, index, txIndex)) return null;
  const prefix = `WILD-LEDGER/JOIN-REQUEST-PRICE-DROPS/${communityId}=`;
  const text = decodeMemo(tx);
  if (!text.startsWith(prefix)) return null;
  const drops = text.slice(prefix.length);
  try { if (joinRequestPriceMemo(communityId, drops) !== text) return null; }
  catch (_) { return null; }
  const hash = String(entry.hash || tx.hash || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) return null;
  return { communityId, drops, account: tx.Account, ledger: index, txIndex, hash, memo: text };
}

export async function readCommunityJoinRequestPrice({ communityId, authority, serverUrl }) {
  const id = canonicalCommunityId(communityId);
  if (!serverUrl) throw new Error("XRPL server is not configured.");
  if (!authority?.authorityEstablished || !Array.isArray(authority.intervals)) {
    throw new Error("Community authority history is not established.");
  }
  const accounts = [...new Set(authority.intervals.map(item => item.account))];
  if (!accounts.length || accounts.some(account => !isClassicAddress(account))) {
    throw new Error("Community authority history contains an invalid wallet.");
  }
  const client = new DirectXRPLClient(serverUrl);
  const history = [];
  try {
    await client.connect();
    for (const account of accounts) {
      let marker;
      do {
        const fields = { account, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: true, limit: 400 };
        if (marker !== undefined) fields.marker = marker;
        const response = await client.request("account_tx", fields, 30000);
        for (const entry of response.result?.transactions || []) {
          const record = recordFromEntry(entry, id, authority);
          if (record) history.push(record);
        }
        marker = response.result?.marker;
      } while (marker !== undefined && marker !== null);
    }
  } finally { client.close(); }
  history.sort((a, b) => a.ledger - b.ledger || a.txIndex - b.txIndex);
  const latest = history.at(-1) || null;
  return { communityId: id, drops: latest?.drops || DEFAULT_JOIN_REQUEST_DROPS, latest, history };
}

export function assertPreparedJoinPrice(tx, expectedWallet, expectedMemo) {
  if (!isCanonicalNoOpAccountSet(tx) || tx?.Account !== expectedWallet) {
    throw new Error("Prepared Join Request Price is not a no-op AccountSet from the authorized wallet.");
  }
  const memos = Array.isArray(tx?.Memos) ? tx.Memos : [];
  if (memos.length !== 1 || memos[0]?.Memo?.MemoType || memos[0]?.Memo?.MemoFormat ||
      String(memos[0]?.Memo?.MemoData || "").toUpperCase() !== textToHex(expectedMemo)) {
    throw new Error("Prepared Join Request Price memo does not match the approved price.");
  }
}
