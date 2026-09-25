/*
 * Sailing Frog's Leap
 * Ambient State Engine — Version 1 ("Hello World")
 *
 * Purpose:
 *   2 signals -> 1 collapsed score -> 2 expressive states.
 *
 * State is remembered in localStorage so the engine has a tiny amount
 * of inertia from one page load to the next.
 *
 * Nothing here depends on XRPL or any external service.
 */

(() => {
  "use strict";

  const VERSION = "1.0.0";
  const STORAGE_KEY = "SFL_LEAP_AMBIENT_STATE_V1";

  // The neutral band creates inertia.
  // A stored state changes only when the score moves clearly past
  // the opposite threshold.
  const ENTER_A_AT = 0.20;
  const ENTER_B_AT = -0.20;

  const expressions = {
    A: [
      "ARR! The air feels lively.",
      "Fair wind in the rigging.",
      "Something aboard feels awake."
    ],
    B: [
      "HMMM... quiet water today.",
      "The pirate is watching the horizon.",
      "Something aboard feels subdued."
    ]
  };

  function clamp(value, min = -1, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(max, Math.max(min, n));
  }

  function readStoredState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (parsed && (parsed.state === "A" || parsed.state === "B")) {
        return parsed;
      }
    } catch (error) {
      // If storage is unavailable or malformed, simply behave as if
      // there is no remembered state.
    }

    return null;
  }

  function writeStoredState(snapshot) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (error) {
      return false;
    }
  }

  function pickExpression(state) {
    const pool = expressions[state] || [];
    if (!pool.length) return "";
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function chooseState(score, previousState) {
    if (!previousState) {
      // First-ever decision: use the sign of the score.
      // An exact zero starts in A merely so the engine always returns a state.
      return score >= 0 ? "A" : "B";
    }

    if (previousState === "A") {
      return score <= ENTER_B_AT ? "B" : "A";
    }

    if (previousState === "B") {
      return score >= ENTER_A_AT ? "A" : "B";
    }

    return score >= 0 ? "A" : "B";
  }

  function evaluate({ signalOne = 0, signalTwo = 0 } = {}) {
    const s1 = clamp(signalOne);
    const s2 = clamp(signalTwo);

    // Version 1 deliberately gives both signals equal weight.
    const score = (s1 + s2) / 2;

    const previous = readStoredState();
    const previousState = previous?.state || null;
    const state = chooseState(score, previousState);

    const snapshot = {
      version: VERSION,
      state,
      score,
      signalOne: s1,
      signalTwo: s2,
      updatedAt: new Date().toISOString()
    };

    const persisted = writeStoredState(snapshot);

    return {
      ...snapshot,
      previousState,
      changed: previousState !== null && previousState !== state,
      expression: pickExpression(state),
      storageKey: STORAGE_KEY,
      persisted,
      thresholds: {
        enterAAt: ENTER_A_AT,
        enterBAt: ENTER_B_AT
      }
    };
  }

  function getStoredState() {
    return readStoredState();
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  // One tiny public interface for any HTML page that wants to use the engine.
  window.AmbientStateEngine = Object.freeze({
    version: VERSION,
    storageKey: STORAGE_KEY,
    evaluate,
    getStoredState,
    reset
  });
})();
