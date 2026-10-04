/*
  Wild Ledger community setup — XRPL-backed application/business state.

  This is NOT LEAP Protocol state.

  Owner-controlled setup fee memo:
    WILD-LEDGER/COMMUNITY-SETUP-FEE-DROPS=<DROPS>

  Prospective Operator request payment memo:
    WILD-LEDGER/COMMUNITY-REQUEST

  Current fee policy in this implementation:
    - the canonical fee is a positive whole number of drops
    - Owner UI presets are convenience only, not a protocol/application limit
    - fee must already exist as valid Owner-signed XRPL state

  A request payment is valid only when:
    - it is a validated tesSUCCESS native-XRP Payment,
    - it is sent from the requesting wallet,
    - it is sent to the canonical Owner Wallet at that ledger position,
    - it contains exactly the canonical request memo,
    - its XRP amount exactly equals the setup fee that was canonical immediately
      before that payment in XRPL transaction order.

  Later fee changes never retroactively alter a previously valid request.
*/

import {
  DirectXRPLClient,
  isClassicAddress,
  isClassicAddress as validAddress,
  prepareNoOpAccountSet,
  prepareTransaction,
  submitSignedTransaction,
  textToHex
} from "./xrplTransport.js";
import {
  resolveOwnerAuthority,
  clearOwnerAuthorityCache,
  isCanonicalNoOpAccountSet
} from "./ownerAuthority.js";

export const SETUP_FEE_PREFIX = "WILD-LEDGER/COMMUNITY-SETUP-FEE-DROPS=";
export const COMMUNITY_REQUEST_MEMO = "WILD-LEDGER/COMMUNITY-REQUEST";
export const DROPS_PER_XRP = 1_000_000;

export function normalizeSetupFeeDrops(value) {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("Setup fee must be a positive whole number of drops.");
  }
  const canonical = raw.replace(/^0+(?=\d)/, "");
  if (canonical === "0") {
    throw new Error("Setup fee must be at least 1 drop.");
  }
  return canonical;
}

export function dropsToXrpString(value) {
  const drops = normalizeSetupFeeDrops(value);
  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const FEE_CACHE = new Map();

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
  const raw = value?.txIndex;
  return {
    ledger: Number(value?.ledger),
    txIndex: raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : null
  };
}

function compareOrder(a, b) {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const ai = Number.isFinite(a.txIndex) ? a.txIndex : -1;
  const bi = Number.isFinite(b.txIndex) ? b.txIndex : -1;
  return ai - bi;
}

function isAfter(a, b) { return compareOrder(a, b) > 0; }
function isBefore(a, b) { return compareOrder(a, b) < 0; }
function isAtOrBefore(a, b) { return compareOrder(a, b) <= 0; }

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

function ownerAuthorizedForSignedRecord(account, recordOrder, intervals) {
  return intervals.some(interval =>
    interval.account === account &&
    isAfter(recordOrder, interval.start) &&
    (!interval.end || isBefore(recordOrder, interval.end))
  );
}

export function ownerAtOrder(ownerState, order) {
  if (!ownerState?.authorityEstablished || !ownerState.initialStatement || !order) return "";
  const initialOrder = orderOf(ownerState.initialStatement);
  if (!isAfter(order, initialOrder)) return "";
  let current = ownerState.initialOwner;
  for (const transition of Array.isArray(ownerState.transitions) ? ownerState.transitions : []) {
    const transitionOrder = orderOf(transition);
    if (compareOrder(order, transitionOrder) > 0) current = transition.to;
    else break;
  }
  return current;
}

export function setupFeeMemo(drops) {
  return `${SETUP_FEE_PREFIX}${normalizeSetupFeeDrops(drops)}`;
}

function parseFeeRecord(entry) {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;
  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;
  const memo = texts[0];
  const match = memo.match(/^WILD-LEDGER\/COMMUNITY-SETUP-FEE-DROPS=([0-9]+)$/);
  if (!match) return null;
  let drops;
  try { drops = normalizeSetupFeeDrops(match[1]); } catch (_) { return null; }
  if (memo !== setupFeeMemo(drops)) return null;
  const xrp = dropsToXrpString(drops);
  const ledger = ledgerIndex(entry, tx);
  if (!Number.isFinite(ledger)) return null;
  return {
    account: String(tx.Account),
    drops,
    xrp,
    ledger,
    txIndex: transactionIndex(entry),
    hash: transactionHash(entry, tx),
    memo
  };
}

function sortOrdered(records, label) {
  const sorted = [...records].sort((a, b) => compareOrder(orderOf(a), orderOf(b)));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1].ledger === sorted[i].ledger &&
        (!Number.isFinite(sorted[i - 1].txIndex) || !Number.isFinite(sorted[i].txIndex))) {
      throw new Error(`${label} needs XRPL transaction ordering for ledger ${sorted[i].ledger}, but TransactionIndex was unavailable.`);
    }
  }
  return sorted;
}

export async function readCommunitySetupFee({ serverUrl, force = false } = {}) {
  const server = String(serverUrl || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!force && FEE_CACHE.has(server)) return structuredClone(FEE_CACHE.get(server));
  if (force) clearOwnerAuthorityCache();

  const ownerState = await resolveOwnerAuthority({ serverUrl: server, force });
  if (!ownerState?.authorityEstablished) throw new Error("Canonical Wild Ledger Owner authority is not established.");

  const intervals = ownerIntervals(ownerState);
  const accounts = [...new Set(intervals.map(item => item.account).filter(Boolean))];
  const client = new DirectXRPLClient(server);
  const records = [];
  try {
    await client.connect();
    for (const account of accounts) {
      const rows = await readAccountHistory(client, account);
      for (const row of rows) {
        const record = parseFeeRecord(row);
        if (!record || record.account !== account) continue;
        if (!ownerAuthorizedForSignedRecord(account, orderOf(record), intervals)) continue;
        records.push(record);
      }
    }
  } finally {
    client.close();
  }

  const sorted = sortOrdered(records, "Community setup fee history");
  const current = sorted.length ? sorted[sorted.length - 1] : null;
  const state = {
    ownerState,
    records: sorted,
    current,
    established: Boolean(current),
    currentFeeDrops: current?.drops ?? null,
    currentFeeXrp: current?.xrp ?? null,
    resolvedAt: new Date().toISOString()
  };
  FEE_CACHE.set(server, state);
  return structuredClone(state);
}

export function feeRecordAtOrder(feeState, order) {
  if (!feeState?.records || !order) return null;
  let found = null;
  for (const record of feeState.records) {
    if (isBefore(orderOf(record), order)) found = record;
    else break;
  }
  return found ? { ...found } : null;
}

export async function prepareCommunitySetupFee({ serverUrl, drops, feeCushion = 1.2 } = {}) {
  const server = String(serverUrl || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  const canonicalDrops = normalizeSetupFeeDrops(drops);
  const memoText = setupFeeMemo(canonicalDrops);
  clearOwnerAuthorityCache();
  const ownerState = await resolveOwnerAuthority({ serverUrl: server, force: true });
  if (!ownerState?.authorityEstablished || !ownerState.currentAccount) throw new Error("Canonical Wild Ledger Owner authority is not established.");
  const prepared = await prepareNoOpAccountSet({
    serverUrl: server,
    account: ownerState.currentAccount,
    memoText,
    feeCushion
  });
  return { ...prepared, ownerAccount: ownerState.currentAccount, drops: canonicalDrops, xrp: dropsToXrpString(canonicalDrops), memoText };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForFee({ serverUrl, drops, timeoutMs = 65000, pollIntervalMs = 2200 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      FEE_CACHE.delete(serverUrl);
      clearOwnerAuthorityCache();
      const state = await readCommunitySetupFee({ serverUrl, force: true });
      if (state.current?.drops === normalizeSetupFeeDrops(drops)) return state;
    } catch (_) {}
    await sleep(pollIntervalMs);
  }
  return null;
}

function ambiguousSubmit(error, accepted) {
  if (accepted) return true;
  return /too busy|server busy|temporar|timeout|timed out|connection|closed|network|tefPAST_SEQ|past_seq/i.test(String(error?.message || error || ""));
}

export async function submitCommunitySetupFee({
  serverUrl,
  signedBlob,
  expectedOwner,
  drops,
  onSubmitted = null
} = {}) {
  const server = String(serverUrl || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  const canonicalDrops = normalizeSetupFeeDrops(drops);
  clearOwnerAuthorityCache();
  const before = await resolveOwnerAuthority({ serverUrl: server, force: true });
  if (before.currentAccount !== expectedOwner) throw new Error("Owner authority changed after preparation. Prepare a new setup-fee transaction.");

  const existing = await readCommunitySetupFee({ serverUrl: server, force: true });
  if (existing.current?.drops === canonicalDrops) {
    return { result: { validated: true, finalResult: "tesSUCCESS", alreadyCanonical: true, txHash: existing.current.hash, ledgerIndex: existing.current.ledger }, feeState: existing, record: existing.current, recovered: true };
  }

  let accepted = null;
  let result;
  try {
    result = await submitSignedTransaction({
      serverUrl: server,
      signedBlob,
      onSubmitted: details => {
        accepted = details || {};
        if (typeof onSubmitted === "function") onSubmitted(details);
      }
    });
  } catch (error) {
    if (!ambiguousSubmit(error, accepted)) throw error;
    const recovered = await waitForFee({ serverUrl: server, drops: canonicalDrops });
    if (recovered?.current?.drops === canonicalDrops) {
      return { result: { validated: true, finalResult: "tesSUCCESS", recoveredAfterSubmitError: true, txHash: recovered.current.hash, ledgerIndex: recovered.current.ledger }, feeState: recovered, record: recovered.current, recovered: true };
    }
    const pending = new Error("XRPL may already have received this signed transaction, but Wild Ledger could not confirm the new setup fee yet. Do not submit it again. Refresh this page and reread XRPL state.");
    pending.doNotResubmit = true;
    throw pending;
  }

  if (result.finalResult !== "tesSUCCESS") throw new Error(`Validated setup-fee transaction returned ${result.finalResult}.`);
  const after = await waitForFee({ serverUrl: server, drops: canonicalDrops, timeoutMs: 30000 });
  if (!after?.current || after.current.drops !== canonicalDrops) {
    const pending = new Error("The transaction validated, but Wild Ledger has not reconstructed the new setup fee yet. Do not submit it again. Refresh this page.");
    pending.doNotResubmit = true;
    throw pending;
  }
  return { result, feeState: after, record: after.current };
}

function requestPaymentFromEntry(entry, expectedAccount = "") {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || tx?.TransactionType !== "Payment") return null;
  const account = String(tx.Account || "");
  if (!isClassicAddress(account) || (expectedAccount && account !== expectedAccount)) return null;
  if (!isClassicAddress(tx.Destination)) return null;
  if (typeof tx.Amount !== "string" || !/^[0-9]+$/.test(tx.Amount)) return null;
  let drops;
  try { drops = normalizeSetupFeeDrops(tx.Amount); } catch (_) { return null; }
  if (drops !== tx.Amount) return null;
  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1 || texts[0] !== COMMUNITY_REQUEST_MEMO) return null;
  const ledger = ledgerIndex(entry, tx);
  if (!Number.isFinite(ledger)) return null;
  return {
    account,
    destination: String(tx.Destination),
    drops,
    sequence: Number(tx.Sequence),
    ledger,
    txIndex: transactionIndex(entry),
    hash: transactionHash(entry, tx),
    memo: texts[0]
  };
}


function communityOperatingWalletMemo(communityId, account) {
  const id = String(communityId || "").trim().toUpperCase();
  const wallet = String(account || "").trim();
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id) || !isClassicAddress(wallet)) return "";
  return `${id}-LEAP/AUTHORITY/OPERATING-WALLET=${wallet}`;
}

function parseCommunityAuthorityRecord(entry, communityId, expectedAccount = "") {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;
  if (expectedAccount && tx.Account !== expectedAccount) return null;
  const texts = decodedMemoTexts(tx);
  if (texts.length !== 1) return null;
  const prefix = `${communityId}-LEAP/AUTHORITY/OPERATING-WALLET=`;
  const memo = texts[0];
  if (!memo.startsWith(prefix)) return null;
  const value = memo.slice(prefix.length);
  if (!isClassicAddress(value) || memo !== communityOperatingWalletMemo(communityId, value)) return null;
  const ledger = ledgerIndex(entry, tx);
  if (!Number.isFinite(ledger)) return null;
  return {
    account: String(tx.Account), value, ledger, txIndex: transactionIndex(entry),
    hash: transactionHash(entry, tx), memo
  };
}

async function resolveProvisionedCommunityCurrentWallet({ serverUrl, provision, historyCache = new Map(), maxTransitions = 50 }) {
  const communityId = String(provision?.communityId || "").trim().toUpperCase();
  let currentAccount = String(provision?.operatingWallet || "").trim();
  if (!communityId || !isClassicAddress(currentAccount)) throw new Error("Provisioning record is incomplete.");
  let activeFrom = orderOf(provision);
  const transitions = [];
  const seen = new Set([currentAccount]);

  async function history(account) {
    if (historyCache.has(account)) return historyCache.get(account);
    const client = new DirectXRPLClient(serverUrl);
    try {
      await client.connect();
      const rows = await readAccountHistory(client, account);
      historyCache.set(account, rows);
      return rows;
    } finally { client.close(); }
  }

  for (let count = 0; count < maxTransitions; count += 1) {
    const statements = sortOrdered(
      (await history(currentAccount))
        .map(row => parseCommunityAuthorityRecord(row, communityId, currentAccount))
        .filter(Boolean)
        .filter(record => isAfter(orderOf(record), activeFrom)),
      `Community ${communityId} authority history`
    );
    let rotation = null;
    for (const statement of statements) {
      activeFrom = orderOf(statement);
      if (statement.value !== currentAccount) { rotation = statement; break; }
    }
    if (!rotation) return { communityId, currentAccount, transitions, provision: { ...provision } };
    transitions.push({ from: currentAccount, to: rotation.value, ledger: rotation.ledger, txIndex: rotation.txIndex, hash: rotation.hash, memo: rotation.memo });
    if (seen.has(rotation.value)) throw new Error(`Community ${communityId} authority history contains a rotation loop.`);
    currentAccount = rotation.value;
    seen.add(currentAccount);
  }
  throw new Error(`Community ${communityId} authority state exceeded the ${maxTransitions}-rotation safety limit.`);
}

export async function findProvisionedCommunityAuthority({ serverUrl, ownerState, wallet = "" } = {}) {
  const server = String(serverUrl || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  const target = String(wallet || "").trim();
  if (target && !isClassicAddress(target)) throw new Error("A valid XRPL classic account is required.");
  const provisions = Array.isArray(ownerState?.provisionedCommunities) ? ownerState.provisionedCommunities : [];
  const historyCache = new Map();
  const communities = [];
  for (const provision of provisions) {
    const resolved = await resolveProvisionedCommunityCurrentWallet({ serverUrl: server, provision, historyCache });
    communities.push(resolved);
  }
  const matches = target ? communities.filter(item => item.currentAccount === target) : communities;
  return { communities, matches };
}

function validProvisionedCommunitiesForWallet(ownerState, account) {
  return (Array.isArray(ownerState?.provisionedCommunities) ? ownerState.provisionedCommunities : [])
    .filter(record => record.operatingWallet === account)
    .map(record => ({ ...record }));
}

export async function readCommunityRequestStatus({ serverUrl, account, force = false } = {}) {
  const server = String(serverUrl || "").trim();
  const wallet = String(account || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!isClassicAddress(wallet)) throw new Error("A valid XRPL classic account is required.");

  const feeState = await readCommunitySetupFee({ serverUrl: server, force });
  const ownerState = feeState.ownerState;
  const initialProvisions = validProvisionedCommunitiesForWallet(ownerState, wallet)
    .sort((a, b) => compareOrder(orderOf(a), orderOf(b)));
  const authority = await findProvisionedCommunityAuthority({ serverUrl: server, ownerState, wallet });
  const currentCommunities = authority.matches;

  const client = new DirectXRPLClient(server);
  let rows = [];
  try {
    await client.connect();
    rows = await readAccountHistory(client, wallet);
  } finally {
    client.close();
  }

  const allRequests = sortOrdered(
    rows.map(row => requestPaymentFromEntry(row, wallet)).filter(Boolean),
    "Community request history"
  );

  const validRequests = [];
  for (const request of allRequests) {
    const requestOrder = orderOf(request);
    const owner = ownerAtOrder(ownerState, requestOrder);
    const feeRecord = feeRecordAtOrder(feeState, requestOrder);
    if (!owner || !feeRecord) continue;
    if (request.destination !== owner) continue;
    if (request.drops !== feeRecord.drops) continue;
    validRequests.push({ ...request, feeXrp: feeRecord.xrp, feeRecord });
  }

  const firstRequest = validRequests[0] || null;
  const firstCurrent = currentCommunities[0] || null;
  const firstInitial = initialProvisions[0] || null;

  let state = "NONE";
  if (firstCurrent) state = "READY";
  else if (firstInitial) state = "TRANSFERRED";
  else if (firstRequest) state = "WAITING";

  return {
    state,
    account: wallet,
    feeState,
    ownerState,
    request: firstRequest,
    validRequests,
    initialProvisionedCommunities: initialProvisions,
    currentlyOperatedCommunities: currentCommunities,
    community: firstCurrent ? {
      communityId: firstCurrent.communityId,
      namespace: firstCurrent.provision.namespace,
      operatingWallet: firstCurrent.currentAccount,
      firstOperatingWallet: firstCurrent.provision.operatingWallet,
      ledger: firstCurrent.provision.ledger,
      hash: firstCurrent.provision.hash
    } : null,
    transferredCommunity: !firstCurrent && firstInitial ? {
      communityId: firstInitial.communityId,
      namespace: firstInitial.namespace,
      firstOperatingWallet: firstInitial.operatingWallet,
      ledger: firstInitial.ledger,
      hash: firstInitial.hash
    } : null
  };
}

export async function prepareCommunityRequestPayment({ serverUrl, account, feeCushion = 1.2 } = {}) {
  const server = String(serverUrl || "").trim();
  const wallet = String(account || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!isClassicAddress(wallet)) throw new Error("A valid XRPL classic account is required.");

  const status = await readCommunityRequestStatus({ serverUrl: server, account: wallet, force: true });
  if (status.state === "READY") throw new Error(`This wallet already operates community ${status.community.communityId}.`);
  if (status.state === "TRANSFERRED") throw new Error(`This wallet was previously provisioned for community ${status.transferredCommunity.communityId}; its Operating Wallet authority has since moved.`);
  if (status.state === "WAITING") throw new Error("A valid community request payment from this wallet is already waiting for provisioning.");
  if (!status.feeState?.current) throw new Error("Wild Ledger has not published a community setup fee on XRPL yet.");

  const ownerAccount = status.ownerState.currentAccount;
  const feeRecord = status.feeState.current;
  const txJson = {
    TransactionType: "Payment",
    Account: wallet,
    Destination: ownerAccount,
    Amount: String(feeRecord.drops),
    Memos: [{ Memo: { MemoData: textToHex(COMMUNITY_REQUEST_MEMO) } }]
  };
  const prepared = await prepareTransaction({ serverUrl: server, txJson, feeCushion });
  return {
    ...prepared,
    ownerAccount,
    feeXrp: feeRecord.xrp,
    feeDrops: feeRecord.drops,
    feeLedger: feeRecord.ledger,
    feeHash: feeRecord.hash,
    memoText: COMMUNITY_REQUEST_MEMO,
    sequence: Number(prepared.preparedTx.Sequence)
  };
}

async function findExactRequest({ serverUrl, account, sequence, destination, drops }) {
  const client = new DirectXRPLClient(serverUrl);
  try {
    await client.connect();
    const rows = await readAccountHistory(client, account);
    const canonicalDrops = normalizeSetupFeeDrops(drops);
    return rows.map(row => requestPaymentFromEntry(row, account)).find(record =>
      record && Number(record.sequence) === Number(sequence) && record.destination === destination && record.drops === canonicalDrops
    ) || null;
  } finally {
    client.close();
  }
}

export async function submitCommunityRequestPayment({
  serverUrl,
  signedBlob,
  account,
  expectedOwner,
  expectedFeeDrops,
  expectedSequence,
  onSubmitted = null
} = {}) {
  const server = String(serverUrl || "").trim();
  const wallet = String(account || "").trim();
  if (!server) throw new Error("XRPL WebSocket URL is required.");
  if (!validAddress(wallet)) throw new Error("A valid request wallet is required.");

  const canonicalExpectedFeeDrops = normalizeSetupFeeDrops(expectedFeeDrops);
  const current = await readCommunitySetupFee({ serverUrl: server, force: true });
  if (current.ownerState.currentAccount !== expectedOwner || current.currentFeeDrops !== canonicalExpectedFeeDrops) {
    throw new Error("The Owner Wallet or setup fee changed after this payment was prepared. Prepare a new payment before signing or submitting.");
  }

  const exactBefore = await findExactRequest({ serverUrl: server, account: wallet, sequence: expectedSequence, destination: expectedOwner, drops: expectedFeeDrops });
  if (exactBefore) {
    const status = await readCommunityRequestStatus({ serverUrl: server, account: wallet, force: true });
    if (status.validRequests.some(item => item.hash === exactBefore.hash)) {
      return { result: { validated: true, finalResult: "tesSUCCESS", alreadyCanonical: true, txHash: exactBefore.hash, ledgerIndex: exactBefore.ledger }, request: exactBefore, status, recovered: true };
    }
  }

  let accepted = null;
  let result;
  try {
    result = await submitSignedTransaction({
      serverUrl: server,
      signedBlob,
      onSubmitted: details => {
        accepted = details || {};
        if (typeof onSubmitted === "function") onSubmitted(details);
      }
    });
  } catch (error) {
    if (!ambiguousSubmit(error, accepted)) throw error;
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      try {
        const exact = await findExactRequest({ serverUrl: server, account: wallet, sequence: expectedSequence, destination: expectedOwner, drops: expectedFeeDrops });
        if (exact) {
          const status = await readCommunityRequestStatus({ serverUrl: server, account: wallet, force: true });
          if (status.validRequests.some(item => item.hash === exact.hash)) {
            return { result: { validated: true, finalResult: "tesSUCCESS", recoveredAfterSubmitError: true, txHash: exact.hash, ledgerIndex: exact.ledger }, request: exact, status, recovered: true };
          }
        }
      } catch (_) {}
      await sleep(2200);
    }
    const pending = new Error("XRPL may already have received this payment, but Wild Ledger could not confirm it yet. Do not submit or pay again. Return to this page and reconnect the same wallet to check the request status.");
    pending.doNotResubmit = true;
    throw pending;
  }

  if (result.finalResult !== "tesSUCCESS") throw new Error(`Validated community request payment returned ${result.finalResult}.`);
  const status = await readCommunityRequestStatus({ serverUrl: server, account: wallet, force: true });
  const request = status.validRequests.find(item => item.hash === result.txHash) || status.request || null;
  if (!request) {
    const pending = new Error("The payment validated, but Wild Ledger has not reconstructed it as a valid community request yet. Do not pay again. Reconnect this same wallet later to check status.");
    pending.doNotResubmit = true;
    throw pending;
  }
  return { result, request, status };
}

export function clearCommunitySetupCache() {
  FEE_CACHE.clear();
}
