/*
  Wild Ledger WalletConnect XRPL signer adapter.

  Responsibility boundary:
  - Receives a fully prepared XRPL transaction from Wild Ledger/XRPL.
  - Carries that exact transaction to a compatible WalletConnect wallet.
  - Requests signature only: submit=false, autofill=false.
  - Returns the signed transaction/blob to Wild Ledger.

  This module never constructs protocol transactions and never submits to XRPL.
*/

import SignClient from "https://esm.sh/@walletconnect/sign-client@2.25.0?bundle";
import { encode } from "https://esm.sh/ripple-binary-codec@2.11.0?bundle";
import { cleanTransactionForSigning, isClassicAddress } from "./xrplTransport.js";

export const XRPL_MAINNET_CHAIN = "xrpl:0";

function findSignedTransaction(response) {
  if (!response || typeof response !== "object") return null;
  const candidates = [
    response.tx_json,
    response.result?.tx_json,
    response.transaction,
    response.result?.transaction,
    response.tx,
    response.result?.tx,
    response
  ];

  return candidates.find(candidate =>
    candidate &&
    typeof candidate === "object" &&
    candidate.TransactionType &&
    (candidate.TxnSignature || candidate.Signers)
  ) || null;
}

function findSignedBlob(response) {
  const candidates = [
    response?.tx_blob,
    response?.result?.tx_blob,
    response?.signedTransaction,
    response?.result?.signedTransaction,
    response?.blob,
    response?.result?.blob
  ];

  return candidates.find(candidate =>
    typeof candidate === "string" &&
    /^[A-Fa-f0-9]+$/.test(candidate) &&
    candidate.length > 40
  ) || "";
}

export class WalletConnectXrplSigner {
  constructor({
    projectId,
    metadata,
    chainId = XRPL_MAINNET_CHAIN,
    sessionRecoveryMs = 60000
  }) {
    this.projectId = String(projectId ?? "").trim();
    this.metadata = metadata || {};
    this.chainId = chainId;
    this.sessionRecoveryMs = Number(sessionRecoveryMs);
    this.client = null;
    this.session = null;
    this.account = "";
    this.walletName = "";
  }

  async init() {
    if (!this.projectId) throw new Error("A Reown / WalletConnect Project ID is required.");
    if (this.client) return this.client;

    this.client = await SignClient.init({
      projectId: this.projectId,
      metadata: this.metadata
    });
    return this.client;
  }

  async recoverApprovedSession() {
    const deadline = Date.now() + this.sessionRecoveryMs;
    while (Date.now() < deadline) {
      const sessions = this.client?.session?.getAll?.() || [];
      const recovered = sessions.find(session => {
        const namespace = session?.namespaces?.xrpl;
        return Array.isArray(namespace?.accounts) && namespace.accounts.length > 0;
      });
      if (recovered) return recovered;
      await new Promise(resolve => setTimeout(resolve, 750));
    }

    throw new Error("The wallet approved the connection, but the browser did not receive the WalletConnect session. Disconnect this site under the wallet's Connected Apps, then retry.");
  }

  resolveAccount(session) {
    const accounts = session?.namespaces?.xrpl?.accounts || [];
    const selected = accounts.find(account => String(account).startsWith(`${this.chainId}:`)) || accounts[0] || "";
    const classicAddress = String(selected).split(":")[2] || "";
    if (!isClassicAddress(classicAddress)) {
      throw new Error("WalletConnect did not return a valid XRPL classic address.");
    }
    return classicAddress;
  }

  async connect({ onUri = null } = {}) {
    await this.init();

    const { uri, approval } = await this.client.connect({
      requiredNamespaces: {
        xrpl: {
          methods: ["xrpl_signTransaction"],
          chains: [this.chainId],
          events: []
        }
      }
    });

    if (!uri) throw new Error("WalletConnect returned no pairing URI.");
    if (typeof onUri === "function") await onUri(uri);

    this.session = await Promise.race([
      approval(),
      this.recoverApprovedSession()
    ]);

    this.account = this.resolveAccount(this.session);
    this.walletName = this.session?.peer?.metadata?.name || "Connected wallet";

    return {
      session: this.session,
      account: this.account,
      walletName: this.walletName
    };
  }

  async disconnect() {
    try {
      if (this.client && this.session?.topic) {
        await this.client.disconnect({
          topic: this.session.topic,
          reason: { code: 6000, message: "User disconnected." }
        });
      }
    } finally {
      this.session = null;
      this.account = "";
      this.walletName = "";
    }
  }

  async signTransaction(preparedTx) {
    if (!this.client || !this.session) throw new Error("WalletConnect session is not active.");
    if (!preparedTx || typeof preparedTx !== "object") throw new Error("A prepared XRPL transaction is required.");
    if (!isClassicAddress(preparedTx.Account)) throw new Error("Prepared transaction does not contain a valid XRPL account.");
    if (preparedTx.Account !== this.account) throw new Error("Prepared transaction account does not match the connected signer account.");

    const response = await this.client.request({
      chainId: this.chainId,
      topic: this.session.topic,
      request: {
        method: "xrpl_signTransaction",
        params: {
          tx_json: preparedTx,
          submit: false,
          autofill: false
        }
      }
    });

    const signedTx = findSignedTransaction(response);
    let signedBlob = findSignedBlob(response);

    if (signedTx) {
      if (!signedTx.TxnSignature && !(Array.isArray(signedTx.Signers) && signedTx.Signers.length)) {
        throw new Error("Wallet returned a transaction object, but no signature was found.");
      }
      if (!signedBlob) signedBlob = encode(cleanTransactionForSigning(signedTx));
    } else if (!signedBlob) {
      throw new Error("Wallet response did not contain a recognizable signed XRPL transaction.");
    }

    if (!signedBlob) throw new Error("Signature was returned, but the signed transaction could not be serialized.");

    return {
      response,
      signedTx,
      signedBlob,
      signatureType: signedTx?.TxnSignature ? "TxnSignature" : signedTx?.Signers ? "Signers" : "blob"
    };
  }
}
