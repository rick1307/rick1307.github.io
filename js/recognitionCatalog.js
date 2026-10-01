/*
  Wild Ledger shared recognition catalog reader — LEAP Protocol 1.0.

  Canonical recognition definitions come from validated XRPL lifecycle history.
  Off-ledger metadata may decorate a definition but never creates one.

  Existing pre-authority communities may also expose recognition IDs established
  by valid historical recognition before that community's lifecycle activation
  point. New post-activation recognition IDs require canonical CREATE.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";
import {
  resolveCommunityAuthority,
  isAuthorizedAtLedger,
  isCanonicalNoOpAccountSet
} from "./communityAuthority.js";

export const RECOGNITION_CATEGORIES = Object.freeze(["BADGE", "CHALLENGE", "EVENT"]);
export const PERMANENT_LEAP_DISTRIBUTOR = "rnbmFoUKhnMZ8QCJ6kA5J2uwfP8rm9cUdU";

const RIPPLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const ACTIONS = new Set(["CREATE", "END", "IGNORE"]);
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

function isStrictlyBefore(a, b) {
  if (!a || !b) return false;
  if (a.ledger !== b.ledger) return a.ledger < b.ledger;
  if (!Number.isFinite(a.txIndex) || !Number.isFinite(b.txIndex)) return false;
  return a.txIndex < b.txIndex;
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

function validCanonicalId(category, value) {
  const id = String(value || "");
  if (category === "CHALLENGE") return /^LEAP-\d{3,}$/.test(id);
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id);
}

function canonicalLeapAmount(amount, issuer, currency) {
  if (!amount || typeof amount !== "object") return false;
  if (String(amount.issuer || "") !== String(issuer || "")) return false;
  if (String(amount.currency || "").toUpperCase() !== String(currency || "").toUpperCase()) return false;
  const value = Number(amount.value);
  return Number.isSafeInteger(value) && value > 0;
}

function lifecycleRecordFromEntry(entry, namespace, authority) {
  const tx = normalizeTx(entry);
  const order = orderFromEntry(entry, tx);
  if (!order) return null;
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx)) return null;
  if (!isAuthorizedAtLedger(authority, tx.Account, order.ledger, order.txIndex)) return null;

  // Current lifecycle writes use one decoded canonical memo and no extra memo text.
  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;

  const text = texts[0];
  const prefix = `${namespace}/RECOGNITION/`;
  const suffix = "/LIFECYCLE-TAG=";
  if (!text.startsWith(prefix)) return null;

  const marker = text.indexOf(suffix, prefix.length);
  if (marker < 0) return null;

  const path = text.slice(prefix.length, marker);
  const parts = path.split("/");
  if (parts.length !== 2) return null;

  const category = parts[0];
  const id = parts[1];
  const action = text.slice(marker + suffix.length);
  if (!RECOGNITION_CATEGORIES.includes(category) || !validCanonicalId(category, id) || !ACTIONS.has(action)) return null;
  if (text !== `${namespace}/RECOGNITION/${category}/${id}/LIFECYCLE-TAG=${action}`) return null;

  return {
    category,
    id,
    action,
    ledger: order.ledger,
    txIndex: order.txIndex,
    time: entryTime(entry, tx),
    hash: transactionHash(entry, tx),
    account: String(tx.Account || ""),
    memo: text
  };
}

function parseCanonicalAwardText(text, namespace) {
  const value = String(text || "").trim();
  const prefix = `${namespace}/`;
  if (!value.startsWith(prefix)) return null;
  const payload = value.slice(prefix.length);
  const equals = payload.indexOf("=");
  if (equals <= 0) return null;
  const category = payload.slice(0, equals).trim().toUpperCase();
  const id = payload.slice(equals + 1).trim().toUpperCase();
  if (!RECOGNITION_CATEGORIES.includes(category) || !validCanonicalId(category, id)) return null;
  return { category, id };
}

function legacyRecognitionFromEntry(entry, { namespace, issuer, currency, activationOrder }) {
  const tx = normalizeTx(entry);
  const order = orderFromEntry(entry, tx);
  if (!order || !isStrictlyBefore(order, activationOrder)) return null;
  if (tx?.TransactionType !== "CheckCreate") return null;
  if (String(tx.Account || "") !== PERMANENT_LEAP_DISTRIBUTOR) return null;
  if (!transactionSucceeded(entry) || !canonicalLeapAmount(tx.SendMax, issuer, currency)) return null;
  if (!isClassicAddress(tx.Destination)) return null;

  const found = new Map();
  const memos = Array.isArray(tx.Memos) ? tx.Memos : [];

  function add(category, id) {
    const normalizedCategory = String(category || "").trim().toUpperCase();
    const normalizedId = String(id || "").trim().toUpperCase();
    if (!RECOGNITION_CATEGORIES.includes(normalizedCategory) || !validCanonicalId(normalizedCategory, normalizedId)) return;
    found.set(`${normalizedCategory}:${normalizedId}`, { category: normalizedCategory, id: normalizedId });
  }

  for (const wrapper of memos) {
    const memo = wrapper?.Memo || {};
    const type = hexToText(memo.MemoType).trim();
    const data = hexToText(memo.MemoData).trim();
    const format = hexToText(memo.MemoFormat).trim();

    for (const text of [data, type, format]) {
      const parsed = parseCanonicalAwardText(text, namespace);
      if (parsed) add(parsed.category, parsed.id);
    }

    const legacyPrefix = `${namespace}/`;
    if (type.startsWith(legacyPrefix) && !type.includes("=")) {
      const category = type.slice(legacyPrefix.length).trim().toUpperCase();
      if (RECOGNITION_CATEGORIES.includes(category)) add(category, data);
      if (category === "NEW-MEMBER") add("BADGE", "NEW-MEMBER");
    }

    if (type === namespace && data) {
      for (const piece of data.split("|")) {
        const equals = piece.indexOf("=");
        if (equals <= 0) continue;
        add(piece.slice(0, equals), piece.slice(equals + 1));
      }
    }
  }

  // One transaction can establish at most one recognition reason.
  if (found.size !== 1) return null;
  const recognition = [...found.values()][0];
  return {
    ...recognition,
    ledger: order.ledger,
    txIndex: order.txIndex,
    time: entryTime(entry, tx),
    hash: transactionHash(entry, tx),
    account: String(tx.Account || ""),
    source: "legacy-recognition"
  };
}

async function readAccountHistory(client, account, { minLedger = -1, maxLedger = -1 } = {}) {
  let marker;
  const rows = [];
  do {
    const fields = {
      account,
      ledger_index_min: Number.isFinite(Number(minLedger)) ? Number(minLedger) : -1,
      ledger_index_max: Number.isFinite(Number(maxLedger)) ? Number(maxLedger) : -1,
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

function applyLegacy(records, record) {
  if (!record) return;
  const key = `${record.category}:${record.id}`;
  const prior = records.get(key);
  if (!prior || compareOrder(record, prior.created) < 0) {
    records.set(key, {
      category: record.category,
      id: record.id,
      state: "ACTIVE",
      source: "legacy",
      created: record,
      terminal: null
    });
  }
}

function applyLifecycle(records, record) {
  if (!record) return;
  const key = `${record.category}:${record.id}`;
  const current = records.get(key) || null;

  if (record.action === "CREATE") {
    if (!current) {
      records.set(key, {
        category: record.category,
        id: record.id,
        state: "ACTIVE",
        source: "lifecycle",
        created: record,
        terminal: null
      });
    }
    return;
  }

  // END and IGNORE do not create a previously unknown post-activation definition.
  // They may terminate either a canonical CREATE or a valid legacy-established ID.
  if (!current || current.state === "ENDED" || current.state === "IGNORED") return;

  records.set(key, {
    ...current,
    state: record.action === "IGNORE" ? "IGNORED" : "ENDED",
    terminal: record
  });
}

function globalRecognitionDefinitions() {
  const configured = globalThis?.WILD_LEDGER_CONFIG?.globalRecognitions;
  if (!Array.isArray(configured)) return [];

  const seen = new Set();
  const definitions = [];
  for (const item of configured) {
    const category = String(item?.category || "").trim().toUpperCase();
    const id = String(item?.id || "").trim().toUpperCase();
    if (!RECOGNITION_CATEGORIES.includes(category) || !validCanonicalId(category, id)) continue;
    const key = `${category}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    definitions.push({ category, id, permanent: item?.permanent !== false });
  }
  return definitions;
}

function sortRecords(records) {
  const categoryOrder = new Map(RECOGNITION_CATEGORIES.map((category, index) => [category, index]));
  return [...records].sort((a, b) => {
    const categoryDiff = categoryOrder.get(a.category) - categoryOrder.get(b.category);
    if (categoryDiff) return categoryDiff;
    if (a.category === "CHALLENGE") {
      const an = Number((a.id.match(/(\d+)$/) || [0, 0])[1]);
      const bn = Number((b.id.match(/(\d+)$/) || [0, 0])[1]);
      if (an !== bn) return an - bn;
    }
    return a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true });
  });
}

function cacheKey({ community, serverUrl, issuer, currency }) {
  return [
    String(serverUrl || ""),
    String(community?.leapNamespace || ""),
    String(community?.operatingWallet || ""),
    String(issuer || ""),
    String(currency || "")
  ].join("|");
}

export async function loadRecognitionCatalog({
  community,
  serverUrl,
  issuer,
  currency,
  force = false,
  includeIgnored = false
}) {
  if (!community) throw new Error("Community configuration is required.");
  const namespace = String(community.leapNamespace || "").trim();
  if (!namespace) throw new Error("Community LEAP namespace is required.");
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required.");
  if (!issuer) throw new Error("Canonical LEAP issuer is required.");
  if (!currency) throw new Error("Canonical LEAP currency is required.");

  const key = cacheKey({ community, serverUrl, issuer, currency });
  if (!force && CACHE.has(key)) {
    const cached = clone(CACHE.get(key));
    if (!includeIgnored) cached.records = cached.records.filter(record => record.state !== "IGNORED");
    return cached;
  }

  const authority = await resolveCommunityAuthority({ community, serverUrl, force });
  if (!authority?.authorityEstablished || !authority?.initialStatement) {
    throw new Error("This community does not yet have canonical XRPL authority state.");
  }

  const activationOrder = {
    ledger: Number(authority.initialStatement.ledger),
    txIndex: Number.isFinite(Number(authority.initialStatement.txIndex)) ? Number(authority.initialStatement.txIndex) : null
  };
  if (!Number.isFinite(activationOrder.ledger)) {
    throw new Error("The community lifecycle activation ledger position could not be resolved.");
  }

  const records = new Map();
  const client = new DirectXRPLClient(serverUrl);

  try {
    await client.connect();

    // Only a pre-authority community migration has a legacy recognition period.
    // A self-identifying initial authority statement marks that narrow case.
    // Brand-new Owner-provisioned communities begin directly in lifecycle state.
    const legacyEligible =
      String(authority.initialStatement.account || "") === String(authority.initialStatement.value || "") &&
      String(authority.initialStatement.account || "") === String(authority.legacyConfiguredAccount || "");

    if (legacyEligible) {
      const legacyRows = await readAccountHistory(client, PERMANENT_LEAP_DISTRIBUTOR, {
        minLedger: -1,
        maxLedger: activationOrder.ledger
      });
      for (const entry of legacyRows) {
        applyLegacy(records, legacyRecognitionFromEntry(entry, {
          namespace,
          issuer,
          currency,
          activationOrder
        }));
      }
    }

    // From activation forward, recognition definitions come only from canonical
    // lifecycle AccountSet history signed by the authorized community wallet.
    const lifecycleRowsByHash = new Map();
    for (const account of Array.isArray(authority.accounts) ? authority.accounts : []) {
      if (!account) continue;
      const rows = await readAccountHistory(client, account, {
        minLedger: activationOrder.ledger,
        maxLedger: -1
      });
      for (const entry of rows) {
        const tx = normalizeTx(entry);
        const hash = transactionHash(entry, tx) || `${ledgerIndex(entry, tx)}:${transactionIndex(entry)}:${tx.Account || ""}`;
        if (!lifecycleRowsByHash.has(hash)) lifecycleRowsByHash.set(hash, entry);
      }
    }

    const lifecycleRecords = [...lifecycleRowsByHash.values()]
      .map(entry => lifecycleRecordFromEntry(entry, namespace, authority))
      .filter(Boolean)
      .sort(compareOrder);

    for (const record of lifecycleRecords) applyLifecycle(records, record);

    // Wild Ledger may provide permanent recognition definitions to every community.
    // These are application-level definitions, not community lifecycle state, so a
    // community CREATE/END/IGNORE cannot create, retire, or suppress them.
    for (const definition of globalRecognitionDefinitions()) {
      records.set(`${definition.category}:${definition.id}`, {
        category: definition.category,
        id: definition.id,
        state: "ACTIVE",
        source: "global",
        permanent: definition.permanent,
        created: null,
        terminal: null
      });
    }

    const result = {
      namespace,
      authority,
      activation: {
        ledger: activationOrder.ledger,
        txIndex: activationOrder.txIndex,
        hash: String(authority.initialStatement.hash || "")
      },
      records: sortRecords(records.values()),
      loadedAt: new Date().toISOString()
    };

    CACHE.set(key, result);
    const cloned = clone(result);
    if (!includeIgnored) cloned.records = cloned.records.filter(record => record.state !== "IGNORED");
    return cloned;
  } finally {
    client.close();
  }
}

export function clearRecognitionCatalogCache() {
  CACHE.clear();
}
