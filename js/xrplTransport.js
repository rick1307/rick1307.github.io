/*
  Wild Ledger direct XRPL transport.

  Canonical responsibilities:
  - Construct/simulate/autofill transactions directly against XRPL.
  - Apply the Wild Ledger fee cushion before a signer sees the transaction.
  - Submit an already-signed blob directly to XRPL.
  - Wait for final validated ledger status.

  This module never signs and never handles private keys.
*/

export const DEFAULT_FEE_CUSHION = 1.2;

export function textToHex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function isClassicAddress(value) {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(value ?? "").trim());
}

export function cleanTransactionForSigning(tx) {
  const clone = JSON.parse(JSON.stringify(tx || {}));
  ["hash", "date", "ledger_index", "validated", "ctid", "meta", "metaData"].forEach(key => delete clone[key]);
  if (clone.SigningPubKey === "") delete clone.SigningPubKey;
  return clone;
}

export class DirectXRPLClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (_) {}
        reject(new Error("XRPL connection timed out."));
      }, timeoutMs);

      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });

      socket.addEventListener("message", event => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;

        this.pending.delete(message.id);
        clearTimeout(pending.timer);

        if (message.status === "error" || message.error) {
          const detail = message.error_message || message.error_exception || message.error || "XRPL request failed.";
          const error = new Error(detail);
          error.response = message;
          pending.reject(error);
        } else {
          pending.resolve(message);
        }
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("XRPL WebSocket connection failed."));
        }
      });

      socket.addEventListener("close", () => {
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("XRPL connection closed."));
        }
        this.pending.clear();
      });
    });
  }

  request(command, fields = {}, timeoutMs = 15000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("XRPL WebSocket is not connected."));
    }

    const id = this.nextId++;
    const payload = { id, command, api_version: 2, ...fields };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command} request timed out.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      try { this.socket.close(); } catch (_) {}
    }
  }
}

export function buildNoOpAccountSet({ account, memoText }) {
  if (!isClassicAddress(account)) throw new Error("A valid XRPL classic account is required.");
  const memo = String(memoText ?? "").trim();
  if (!memo) throw new Error("A memo is required.");

  return {
    TransactionType: "AccountSet",
    Account: account,
    Memos: [{ Memo: { MemoData: textToHex(memo) } }]
  };
}

export async function prepareTransaction({
  serverUrl,
  txJson,
  feeCushion = DEFAULT_FEE_CUSHION
}) {
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required.");
  if (!txJson || typeof txJson !== "object") throw new Error("A transaction object is required.");
  if (!Number.isFinite(Number(feeCushion)) || Number(feeCushion) < 1) {
    throw new Error("Fee cushion must be at least 1.0.");
  }

  const client = new DirectXRPLClient(serverUrl);
  try {
    await client.connect();

    const simulationResponse = await client.request("simulate", { tx_json: txJson, binary: false });
    const simulationResult = simulationResponse.result || {};
    const engineResult = simulationResult.engine_result || simulationResult.meta?.TransactionResult || "UNKNOWN";
    const engineMessage = simulationResult.engine_result_message || "";

    if (engineResult !== "tesSUCCESS") {
      throw new Error(`XRPL simulation returned ${engineResult}${engineMessage ? `: ${engineMessage}` : ""}`);
    }

    const preparedTx = cleanTransactionForSigning(simulationResult.tx_json || {});
    if (!preparedTx.TransactionType || !preparedTx.Account) {
      throw new Error("XRPL returned an incomplete prepared transaction.");
    }

    const feeResponse = await client.request("fee");
    const openLedgerFee = Number(feeResponse?.result?.drops?.open_ledger_fee || 0);
    const simulatedFee = Number(preparedTx.Fee || 0);
    const cushionedFee = Math.max(simulatedFee, Math.ceil(openLedgerFee * Number(feeCushion)));

    if (!Number.isFinite(cushionedFee) || cushionedFee <= 0) {
      throw new Error("XRPL returned an unusable fee estimate.");
    }

    preparedTx.Fee = String(cushionedFee);

    return {
      preparedTx,
      engineResult,
      engineMessage,
      simulationResponse,
      feeResponse,
      feeCushion: Number(feeCushion),
      simulatedFee,
      openLedgerFee,
      finalFee: cushionedFee
    };
  } finally {
    client.close();
  }
}

export async function prepareNoOpAccountSet({
  serverUrl,
  account,
  memoText,
  feeCushion = DEFAULT_FEE_CUSHION
}) {
  const txJson = buildNoOpAccountSet({ account, memoText });
  const result = await prepareTransaction({ serverUrl, txJson, feeCushion });

  if (result.preparedTx.TransactionType !== "AccountSet" || result.preparedTx.Account !== account) {
    throw new Error("XRPL returned an unexpected prepared AccountSet transaction.");
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function finalTransactionResult(result) {
  return result?.meta?.TransactionResult || result?.metaData?.TransactionResult || result?.engine_result || "UNKNOWN";
}

export async function submitSignedTransaction({
  serverUrl,
  signedBlob,
  validationTimeoutMs = 60000,
  pollIntervalMs = 1800,
  onSubmitted = null
}) {
  const blob = String(signedBlob ?? "").trim();
  if (!blob || !/^[A-Fa-f0-9]+$/.test(blob)) throw new Error("A serialized signed XRPL transaction is required.");
  if (!serverUrl) throw new Error("XRPL WebSocket URL is required.");

  const client = new DirectXRPLClient(serverUrl);
  try {
    await client.connect();

    const submitResponse = await client.request("submit", { tx_blob: blob, fail_hard: false }, 20000);
    const submitResult = submitResponse.result || {};
    const engineResult = submitResult.engine_result || "UNKNOWN";
    const engineMessage = submitResult.engine_result_message || "";
    const txHash = submitResult.tx_json?.hash || submitResult.hash || "";

    if (engineResult !== "tesSUCCESS") {
      const error = new Error(`XRPL submit returned ${engineResult}${engineMessage ? `: ${engineMessage}` : ""}`);
      error.submitResponse = submitResponse;
      throw error;
    }
    if (!txHash) {
      const error = new Error("XRPL accepted the transaction but did not return its hash.");
      error.submitResponse = submitResponse;
      throw error;
    }

    if (typeof onSubmitted === "function") {
      onSubmitted({ submitResponse, engineResult, engineMessage, txHash });
    }

    const deadline = Date.now() + Number(validationTimeoutMs);
    let lastLookup = null;

    while (Date.now() < deadline) {
      await sleep(Number(pollIntervalMs));
      try {
        const lookup = await client.request("tx", { transaction: txHash, binary: false }, 15000);
        lastLookup = lookup;
        const result = lookup.result || {};

        if (result.validated === true) {
          return {
            submitResponse,
            txLookup: lookup,
            txHash,
            ledgerIndex: result.ledger_index ?? null,
            validated: true,
            finalResult: finalTransactionResult(result)
          };
        }
      } catch (lookupError) {
        const message = String(lookupError?.message || lookupError);
        if (!/not found|txnNotFound/i.test(message)) throw lookupError;
      }
    }

    const seconds = Math.max(1, Math.round(Number(validationTimeoutMs) / 1000));
    const error = new Error(`XRPL accepted the transaction, but validation was not confirmed within ${seconds} seconds. Do not re-sign; the same signed blob can be checked or re-submitted safely.`);
    error.submitResponse = submitResponse;
    error.lastLookup = lastLookup;
    error.txHash = txHash;
    throw error;
  } finally {
    client.close();
  }
}
