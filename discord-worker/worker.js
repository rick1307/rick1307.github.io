const DISCORD_CLIENT_ID = "1550985813553324032";
const REDIRECT_URI = "https://sfl-discord-auth.yjc26zd6c4.workers.dev/callback";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_ME_URL = "https://discord.com/api/users/@me";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GUILD_ID = "970431174579204156";
const LEAPER_LOUNGE_URL = "https://discord.com/channels/970431174579204156/970431175099293730";

const DISCORD_ROLE_IDS = Object.freeze({
  "Deckhand": "1550946675223437383",
  "Bosun": "1550947420731473930",
  "Quartermaster": "1550947517900783666",
  "First Mate": "1550947598959902871",
  "Master of the Leap": "1550948160061308960"
});

const ALL_LEAP_ROLE_IDS = Object.freeze(Object.values(DISCORD_ROLE_IDS));

const XRPL_RPC_URL = "http://s1.ripple.com:51234/";
const LEAP_ISSUER = "rh7SidU91xGW2Za5RvoKiCgS2YB2psTBgq";

const STATE_COOKIE = "sfl_oauth_state";
const BRIDGE_COOKIE = "sfl_oauth_bridge";
const COOKIE_MAX_AGE_SECONDS = 600;
const EXPECTED_SITE_ORIGIN = "https://sailingfrogsleap.com";

const CLASSIC_ADDRESS_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      if (request.method === "POST") {
        return startDiscordOAuth(request, env);
      }

      return htmlResponse(
        "Start from your Crew Record",
        "<p>Open your verified LEAP Crew Record first, then use its Discord button.</p>",
        400
      );
    }

    if (url.pathname === "/callback") {
      return handleDiscordCallback(request, url, env);
    }

    return new Response("SFL Discord Auth is running", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};

async function startDiscordOAuth(request, env) {
  if (!env.DISCORD_OAUTH_SECRET) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Discord OAuth secret is not configured on the Worker.</p>",
      500
    );
  }

  if (!env.DISCORD_BOT_TOKEN) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Discord bot token is not configured on the Worker.</p>",
      500
    );
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== EXPECTED_SITE_ORIGIN) {
    return htmlResponse(
      "Discord connection blocked",
      "<p>This connection must begin from the Sailing Frog's Leap Crew Record.</p>",
      403
    );
  }

  let form;

  try {
    form = await request.formData();
  } catch (_) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Crew Record handoff was incomplete. Please return to the LEAP site and try again.</p>",
      400
    );
  }

  const account = String(form.get("wallet") || "").trim();

  if (!CLASSIC_ADDRESS_PATTERN.test(account)) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Crew Record did not provide a valid XRPL address.</p>",
      400
    );
  }

  let balance;

  try {
    balance = await queryLeapBalance(account);
  } catch (error) {
    console.error("XRPL verification failed before Discord OAuth", error);

    return htmlResponse(
      "Discord connection paused",
      "<p>The XRP Ledger could not be checked right now. Please return to your Crew Record and try again.</p>",
      503
    );
  }

  if (!(balance >= 1)) {
    return htmlResponse(
      "LEAP membership not found",
      "<p>This wallet does not currently hold LEAP, so the Discord connection was not started.</p>",
      403
    );
  }

  const state = crypto.randomUUID();
  const bridgeValue = await createSignedBridgeValue(account, env.DISCORD_OAUTH_SECRET);
  const auth = new URL(DISCORD_AUTHORIZE_URL);

  auth.searchParams.set("client_id", DISCORD_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", REDIRECT_URI);
  auth.searchParams.set("scope", "identify");
  auth.searchParams.set("state", state);

  const headers = new Headers({
    "location": auth.toString(),
    "cache-control": "no-store"
  });

  appendCookie(headers, makeCookie(STATE_COOKIE, encodeURIComponent(state), COOKIE_MAX_AGE_SECONDS));
  appendCookie(headers, makeCookie(BRIDGE_COOKIE, encodeURIComponent(bridgeValue), COOKIE_MAX_AGE_SECONDS));

  return new Response(null, {
    status: 303,
    headers
  });
}

async function handleDiscordCallback(request, url, env) {
  const clearCookies = [
    makeCookie(STATE_COOKIE, "", 0),
    makeCookie(BRIDGE_COOKIE, "", 0)
  ];

  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlResponse(
      "Discord connection cancelled",
      `<p>Discord did not authorize the connection.</p><p>${escapeHtml(errorDescription || error)}</p>`,
      400,
      clearCookies
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = decodeURIComponent(getCookie(request.headers.get("cookie"), STATE_COOKIE) || "");
  const rawBridgeCookie = decodeURIComponent(getCookie(request.headers.get("cookie"), BRIDGE_COOKIE) || "");

  if (!code || !returnedState || !savedState || !rawBridgeCookie) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The OAuth response or Crew Record handoff was incomplete. Please start again from your Crew Record.</p>",
      400,
      clearCookies
    );
  }

  if (!safeEqual(returnedState, savedState)) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The OAuth security check failed. Please start again from your Crew Record.</p>",
      400,
      clearCookies
    );
  }

  if (!env.DISCORD_OAUTH_SECRET) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Discord OAuth secret is not configured on the Worker.</p>",
      500,
      clearCookies
    );
  }

  if (!env.DISCORD_BOT_TOKEN) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Discord bot token is not configured on the Worker.</p>",
      500,
      clearCookies
    );
  }

  const bridge = await verifySignedBridgeValue(rawBridgeCookie, env.DISCORD_OAUTH_SECRET);

  if (!bridge) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Crew Record handoff expired or failed its integrity check. Please start again from your Crew Record.</p>",
      400,
      clearCookies
    );
  }

  let currentBalance;

  try {
    currentBalance = await queryLeapBalance(bridge.wallet);
  } catch (error) {
    console.error("XRPL verification failed during Discord callback", error);

    return htmlResponse(
      "Discord connection paused",
      "<p>Discord authorized successfully, but the XRP Ledger could not be checked again. Please return to your Crew Record and try again.</p>",
      503,
      clearCookies
    );
  }

  if (!(currentBalance >= 1)) {
    return htmlResponse(
      "LEAP membership not found",
      "<p>Discord authorized successfully, but this wallet no longer has a current LEAP balance.</p>",
      403,
      clearCookies
    );
  }

  try {
    const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_OAUTH_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text();
      console.error("Discord token exchange failed", tokenResponse.status, details);

      return htmlResponse(
        "Discord connection failed",
        "<p>Discord rejected the authorization exchange. Please start again from your Crew Record.</p>",
        502,
        clearCookies
      );
    }

    const token = await tokenResponse.json();

    if (!token.access_token) {
      return htmlResponse(
        "Discord connection failed",
        "<p>Discord did not return an access token.</p>",
        502,
        clearCookies
      );
    }

    const userResponse = await fetch(DISCORD_ME_URL, {
      headers: {
        "authorization": `Bearer ${token.access_token}`
      }
    });

    if (!userResponse.ok) {
      const details = await userResponse.text();
      console.error("Discord user lookup failed", userResponse.status, details);

      return htmlResponse(
        "Discord connection failed",
        "<p>Discord authorized the request, but the user profile could not be read.</p>",
        502,
        clearCookies
      );
    }

    const user = await userResponse.json();
    const displayName = user.global_name || user.username || "Discord member";
    const rank = rankFor(currentBalance);
    const desiredRoleId = DISCORD_ROLE_IDS[rank];

    if (!user.id || !desiredRoleId) {
      return htmlResponse(
        "Discord connection failed",
        "<p>The Worker could not determine the Discord member or LEAP rank role.</p>",
        500,
        clearCookies
      );
    }

    await syncDiscordRankRole(user.id, desiredRoleId, env.DISCORD_BOT_TOKEN);

    return redirectResponse(LEAPER_LOUNGE_URL, clearCookies);
  } catch (err) {
    console.error("Discord OAuth callback error", err);

    if (err?.code === "NOT_IN_GUILD") {
      return htmlResponse(
        "Join Leaper Lounge first",
        "<p>Discord recognized your account, but that account is not currently in Leaper Lounge. Join the server, then return to your Crew Record and connect Discord again.</p>",
        409,
        clearCookies
      );
    }

    return htmlResponse(
      "Discord connection failed",
      "<p>The Worker could not complete the Discord connection. Please try again from your Crew Record.</p>",
      500,
      clearCookies
    );
  }
}

async function syncDiscordRankRole(userId, desiredRoleId, botToken) {
  const memberResponse = await fetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${userId}`,
    {
      headers: {
        "authorization": `Bot ${botToken}`
      }
    }
  );

  if (memberResponse.status === 404) {
    const error = new Error("Discord member is not in Leaper Lounge");
    error.code = "NOT_IN_GUILD";
    throw error;
  }

  if (!memberResponse.ok) {
    const details = await memberResponse.text();
    console.error("Discord member lookup failed", memberResponse.status, details);
    throw new Error(`Discord member lookup failed with HTTP ${memberResponse.status}`);
  }

  const member = await memberResponse.json();
  const currentRoles = new Set(Array.isArray(member.roles) ? member.roles : []);

  for (const roleId of ALL_LEAP_ROLE_IDS) {
    if (roleId === desiredRoleId || !currentRoles.has(roleId)) continue;
    await changeDiscordRole(userId, roleId, "DELETE", botToken);
  }

  if (!currentRoles.has(desiredRoleId)) {
    await changeDiscordRole(userId, desiredRoleId, "PUT", botToken);
  }
}

async function changeDiscordRole(userId, roleId, method, botToken) {
  const response = await fetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
    {
      method,
      headers: {
        "authorization": `Bot ${botToken}`
      }
    }
  );

  if (response.status === 204) return;

  const details = await response.text();
  console.error("Discord role change failed", method, roleId, response.status, details);
  throw new Error(`Discord role change failed with HTTP ${response.status}`);
}

async function queryLeapBalance(account) {
  const response = await fetch(XRPL_RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      method: "account_lines",
      params: [{
        account,
        peer: LEAP_ISSUER,
        ledger_index: "validated"
      }]
    })
  });

  if (!response.ok) {
    throw new Error(`XRPL HTTP ${response.status}`);
  }

  const payload = await response.json();
  const result = payload?.result || {};

  if (result.error) {
    if (result.error === "actNotFound") return 0;
    throw new Error(result.error);
  }

  const lines = Array.isArray(result.lines) ? result.lines : [];
  const leapLine = lines.find(line => {
    if (!line || line.account !== LEAP_ISSUER) return false;
    const currency = decodeHexCurrency(String(line.currency || "")).toUpperCase();
    return currency === "LEAP" || currency.startsWith("LEAP");
  });

  if (!leapLine) return 0;

  const balance = Number(leapLine.balance);
  return Number.isFinite(balance) ? balance : 0;
}

function decodeHexCurrency(code) {
  if (!/^[A-Fa-f0-9]{40}$/.test(code)) return code;

  try {
    let text = "";

    for (let i = 0; i < code.length; i += 2) {
      const n = parseInt(code.slice(i, i + 2), 16);
      if (n === 0) break;
      text += String.fromCharCode(n);
    }

    return text;
  } catch (_) {
    return code;
  }
}

async function createSignedBridgeValue(wallet, secret) {
  const expires = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
  const payload = `${wallet}|${expires}`;
  const signature = await hmacHex(secret, `SFL-DISCORD-BRIDGE|${payload}`);
  return `${payload}|${signature}`;
}

async function verifySignedBridgeValue(value, secret) {
  const parts = String(value || "").split("|");
  if (parts.length !== 3) return null;

  const [wallet, expiresText, signature] = parts;

  if (!CLASSIC_ADDRESS_PATTERN.test(wallet)) return null;
  if (!/^\d+$/.test(expiresText)) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || Math.floor(Date.now() / 1000) > expires) return null;

  const payload = `${wallet}|${expiresText}`;
  const expected = await hmacHex(secret, `SFL-DISCORD-BRIDGE|${payload}`);

  if (!safeEqual(signature.toLowerCase(), expected.toLowerCase())) return null;

  return { wallet, expires };
}

async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name:"HMAC", hash:"SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return "";

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }

  return "";
}

function makeCookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function appendCookie(headers, cookie) {
  headers.append("set-cookie", cookie);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

function rankFor(balance) {
  if (balance >= 51) return "Master of the Leap";
  if (balance >= 25) return "First Mate";
  if (balance >= 10) return "Quartermaster";
  if (balance >= 5) return "Bosun";
  if (balance >= 1) return "Deckhand";
  return "Not aboard";
}

function shortAddress(account) {
  return account.length > 20
    ? `${account.slice(0,10)}â€¦${account.slice(-8)}`
    : account;
}

function formatBalance(balance) {
  return Number.isInteger(balance)
    ? String(balance)
    : String(Number(balance.toFixed(6)));
}

function redirectResponse(location, setCookies = []) {
  const headers = new Headers({
    "location": location,
    "cache-control": "no-store"
  });

  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(null, {
    status: 303,
    headers
  });
}

function htmlResponse(title, body, status = 200, setCookies = []) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  });

  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;padding:32px 18px;background:#e2ebe6;color:#17313a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    main{max-width:680px;margin:10vh auto;background:#fff;border:1px solid rgba(18,59,70,.15);border-radius:18px;padding:28px;box-shadow:0 18px 40px rgba(11,45,54,.10)}
    h1{margin:0 0 14px;color:#0b2d36;font-family:Georgia,"Times New Roman",serif}
    p{line-height:1.55}
    code{overflow-wrap:anywhere}
    .note{margin-top:22px;padding-top:18px;border-top:1px solid rgba(18,59,70,.14);font-size:.9rem;color:#45636a}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
</body>
</html>`,
    { status, headers }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
