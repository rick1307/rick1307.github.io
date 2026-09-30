/*
  Wild Ledger Community Authority resolver.

  Community identity is permanent. The Community Operating Account may rotate.
  The immutable authorityRootAccount in communityConfig.js is a protocol trust
  anchor; every later authority transition is reconstructed from validated XRPL
  history.

  Routine rotation requires two signed no-op AccountSet records:
    <NS>/COMMUNITY/AUTHORITY/AUTH-NNN/SUCCESSOR=<new account>
    <NS>/COMMUNITY/AUTHORITY/AUTH-NNN/PREDECESSOR=<old account>

  A still-pending proposal may be canceled by the current authority with:
    <NS>/COMMUNITY/AUTHORITY/AUTH-NNN/CANCEL-SUCCESSOR=<new account>

  Wild Ledger never treats browser storage or a mutable config value as the
  current authority. The current account is resolved from the root + XRPL chain.
*/

import { DirectXRPLClient, isClassicAddress } from "./xrplTransport.js";

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
  const value = entry?.ledger_index ?? entry?.ledgerIndex ?? tx?.ledger_index ?? tx?.ledgerIndex;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transactionHash(entry, tx = normalizeTx(entry)) {
  return String(entry?.hash || entry?.tx_hash || tx?.hash || "");
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

function memoTexts(tx) {
  const texts = [];
  for (const wrapper of Array.isArray(tx?.Memos) ? tx.Memos : []) {
    const memo = wrapper?.Memo || {};
    for (const field of [memo.MemoData, memo.MemoType, memo.MemoFormat]) {
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

export function authorityTransitionId(number) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Authority transition number must be a positive integer.");
  return `AUTH-${String(n).padStart(3, "0")}`;
}

export function authoritySuccessorMemo(namespace, transitionId, successorAccount) {
  return `${namespace}/COMMUNITY/AUTHORITY/${transitionId}/SUCCESSOR=${successorAccount}`;
}

export function authorityPredecessorMemo(namespace, transitionId, predecessorAccount) {
  return `${namespace}/COMMUNITY/AUTHORITY/${transitionId}/PREDECESSOR=${predecessorAccount}`;
}

export function authorityCancelMemo(namespace, transitionId, successorAccount) {
  return `${namespace}/COMMUNITY/AUTHORITY/${transitionId}/CANCEL-SUCCESSOR=${successorAccount}`;
}

function parseAuthorityMemo(text, namespace) {
  const prefix = `${namespace}/COMMUNITY/AUTHORITY/`;
  if (!String(text).startsWith(prefix)) return null;

  const rest = String(text).slice(prefix.length);
  const match = rest.match(/^(AUTH-(\d{3,}))\/(SUCCESSOR|PREDECESSOR|CANCEL-SUCCESSOR)=(r[1-9A-HJ-NP-Za-km-z]{24,34})$/);
  if (!match) return null;

  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;

  return {
    transitionId: match[1],
    sequence,
    action: match[3],
    counterparty: match[4]
  };
}

function authorityActionFromEntry(entry, namespace) {
  const tx = normalizeTx(entry);
  if (!transactionSucceeded(entry) || !isCanonicalNoOpAccountSet(tx) || !isClassicAddress(tx.Account)) return null;

  const matches = memoTexts(tx)
    .map(text => parseAuthorityMemo(text, namespace))
    .filter(Boolean);

  // Fail closed on an AccountSet that tries to carry more than one authority command.
  if (matches.length !== 1) return null;

  const parsed = matches[0];
  return {
    ...parsed,
    account: tx.Account,
    ledger: ledgerIndex(entry, tx),
    hash: transactionHash(entry, tx)
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

function cacheKey({ namespace, rootAccount, serverUrl }) {
  return `${serverUrl}|${namespace}|${rootAccount}`;
}

function firstAcceptance(actions, { transitionId, predecessor, minimumLedger, maximumLedger = Infinity }) {
  return actions
    .filter(action =>
      action.action === "PREDECESSOR" &&
      action.transitionId === transitionId &&
      action.counterparty === predecessor &&
      Number.isFinite(action.ledger) &&
      action.ledger >= minimumLedger &&
      action.ledger <= maximumLedger
    )
    .sort((a, b) => a.ledger - b.ledger)[0] || null;
}

export async function resolveCommunityAuthority({
  community,
  serverUrl,
  force = false,
  maxTransitions = 50
}) {
  if (!community) throw new Error("Community configuration is required.");
  const namespace = String(community.leapNamespace || "").trim();
  if (!namespace) throw new Error("Community LEAP namespace is required.");

  // operatingWallet is accepted only as a temporary backward-compatible root
  // while older community records are migrated to authorityRootAccount.
  const rootAccount = String(community.authorityRootAccount || community.operatingWallet || "").trim();
  if (!isClassicAddress(rootAccount)) {
    throw new Error(`${community.communityName || namespace} does not have a valid authority root account configured.`);
  }
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required.");

  const key = cacheKey({ namespace, rootAccount, serverUrl });
  if (!force && CACHE.has(key)) return clone(CACHE.get(key));

  const client = new DirectXRPLClient(serverUrl);
  const historyCache = new Map();
  const actionCache = new Map();

  async function actionsFor(account) {
    if (actionCache.has(account)) return actionCache.get(account);
    let rows = historyCache.get(account);
    if (!rows) {
      rows = await readAccountHistory(client, account);
      historyCache.set(account, rows);
    }
    const actions = rows
      .map(entry => authorityActionFromEntry(entry, namespace))
      .filter(Boolean)
      .filter(action => Number.isFinite(action.ledger))
      .sort((a, b) => a.ledger - b.ledger);
    actionCache.set(account, actions);
    return actions;
  }

  try {
    await client.connect();

    const accounts = [rootAccount];
    const transitions = [];
    const intervals = [];
    let currentAccount = rootAccount;
    let activeFromLedger = 0;
    let pendingTransition = null;

    for (let step = 1; step <= maxTransitions; step += 1) {
      const transitionId = authorityTransitionId(step);
      const currentActions = (await actionsFor(currentAccount)).filter(action =>
        action.transitionId === transitionId &&
        action.account === currentAccount &&
        action.ledger >= activeFromLedger &&
        (action.action === "SUCCESSOR" || action.action === "CANCEL-SUCCESSOR")
      );

      let activeProposal = null;
      let finalized = null;

      for (const action of currentActions) {
        if (activeProposal) {
          const successorActions = await actionsFor(activeProposal.to);
          const acceptance = firstAcceptance(successorActions, {
            transitionId,
            predecessor: currentAccount,
            minimumLedger: activeProposal.ledger,
            maximumLedger: action.ledger
          });
          if (acceptance) {
            finalized = { proposal: activeProposal, acceptance };
            break;
          }
        }

        if (action.action === "SUCCESSOR") {
          if (accounts.includes(action.counterparty)) {
            throw new Error(`Authority chain cycle detected at ${transitionId}.`);
          }
          if (!activeProposal) {
            activeProposal = {
              transitionId,
              from: currentAccount,
              to: action.counterparty,
              ledger: action.ledger,
              hash: action.hash
            };
          } else if (activeProposal.to !== action.counterparty) {
            throw new Error(`${transitionId} has more than one uncanceled successor proposal. Authority resolution stopped.`);
          }
        } else if (action.action === "CANCEL-SUCCESSOR") {
          if (activeProposal && activeProposal.to === action.counterparty) activeProposal = null;
        }
      }

      if (!finalized && activeProposal) {
        const successorActions = await actionsFor(activeProposal.to);
        const acceptance = firstAcceptance(successorActions, {
          transitionId,
          predecessor: currentAccount,
          minimumLedger: activeProposal.ledger
        });
        if (acceptance) finalized = { proposal: activeProposal, acceptance };
      }

      if (!finalized) {
        if (activeProposal) {
          pendingTransition = {
            transitionId,
            from: currentAccount,
            to: activeProposal.to,
            proposalLedger: activeProposal.ledger,
            proposalHash: activeProposal.hash
          };
        }
        break;
      }

      const effectiveLedger = Math.max(finalized.proposal.ledger, finalized.acceptance.ledger);
      if (effectiveLedger > activeFromLedger) {
        intervals.push({
          account: currentAccount,
          fromLedger: activeFromLedger,
          throughLedger: effectiveLedger - 1
        });
      }

      transitions.push({
        transitionId,
        from: currentAccount,
        to: finalized.proposal.to,
        proposalLedger: finalized.proposal.ledger,
        proposalHash: finalized.proposal.hash,
        acceptanceLedger: finalized.acceptance.ledger,
        acceptanceHash: finalized.acceptance.hash,
        effectiveLedger
      });

      currentAccount = finalized.proposal.to;
      accounts.push(currentAccount);
      activeFromLedger = effectiveLedger;
    }

    if (transitions.length >= maxTransitions) {
      throw new Error(`Authority chain exceeded the ${maxTransitions}-transition safety limit.`);
    }

    intervals.push({ account: currentAccount, fromLedger: activeFromLedger, throughLedger: null });

    const state = {
      namespace,
      rootAccount,
      currentAccount,
      accounts,
      transitions,
      intervals,
      pendingTransition,
      nextTransitionId: authorityTransitionId(transitions.length + 1),
      resolvedAt: new Date().toISOString()
    };

    CACHE.set(key, state);
    return clone(state);
  } finally {
    client.close();
  }
}

export function isAuthorizedAtLedger(authorityState, account, ledger) {
  const target = String(account || "");
  const index = Number(ledger);
  if (!target || !Number.isFinite(index)) return false;

  return (authorityState?.intervals || []).some(interval =>
    interval.account === target &&
    index >= Number(interval.fromLedger || 0) &&
    (interval.throughLedger === null || index <= Number(interval.throughLedger))
  );
}

export function authorityAccountAtLedger(authorityState, ledger) {
  const index = Number(ledger);
  if (!Number.isFinite(index)) return "";
  return (authorityState?.intervals || []).find(interval =>
    index >= Number(interval.fromLedger || 0) &&
    (interval.throughLedger === null || index <= Number(interval.throughLedger))
  )?.account || "";
}

export function clearCommunityAuthorityCache() {
  CACHE.clear();
}
