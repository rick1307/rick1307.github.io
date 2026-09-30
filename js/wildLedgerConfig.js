/*
  Wild Ledger platform-wide runtime configuration.
  These values are shared across every participating community.
  Community identity, ranks, themes, namespaces, and operator settings belong in communityConfig.js.
*/
(() => {
  window.WILD_LEDGER_CONFIG = Object.freeze({
    leapIssuer: "rh7SidU91xGW2Za5RvoKiCgS2YB2psTBgq",
    leapCurrency: "4C45415000000000000000000000000000000000",
    leapTransferLimit: "1000000",
    leapDistributors: Object.freeze([
      "rnbmFoUKhnMZ8QCJ6kA5J2uwfP8rm9cUdU"
    ]),
    xrplWebSocket: "wss://s1.ripple.com/",
    xrplFeeCushion: 1.2,
    walletConnectProjectId: "be456e8bbaa197eaa9d39bb2e4d3208d",
    discordOAuthStartUrl: "https://sfl-discord-auth.yjc26zd6c4.workers.dev/start"
  });
})();
