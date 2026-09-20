const DISCORD_CLIENT_ID = "1550985813553324032";
const REDIRECT_URI = "https://sfl-discord-auth.yjc26zd6c4.workers.dev/callback";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_ME_URL = "https://discord.com/api/users/@me";
const STATE_COOKIE = "sfl_oauth_state";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      return startDiscordOAuth();
    }

    if (url.pathname === "/callback") {
      return handleDiscordCallback(request, url, env);
    }

    return new Response("SFL Discord Auth is running", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};

function startDiscordOAuth() {
  const state = crypto.randomUUID();
  const auth = new URL(DISCORD_AUTHORIZE_URL);

  auth.searchParams.set("client_id", DISCORD_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", REDIRECT_URI);
  auth.searchParams.set("scope", "identify");
  auth.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      "location": auth.toString(),
      "set-cookie": `${STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
      "cache-control": "no-store"
    }
  });
}

async function handleDiscordCallback(request, url, env) {
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlResponse(
      "Discord connection cancelled",
      `<p>Discord did not authorize the connection.</p><p>${escapeHtml(errorDescription || error)}</p>`,
      400,
      clearStateCookie()
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = getCookie(request.headers.get("cookie"), STATE_COOKIE);

  if (!code || !returnedState || !savedState) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The OAuth response was incomplete. Please start again from the LEAP site.</p>",
      400,
      clearStateCookie()
    );
  }

  if (!safeEqual(returnedState, savedState)) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The OAuth security check failed. Please start again from the LEAP site.</p>",
      400,
      clearStateCookie()
    );
  }

  if (!env.DISCORD_OAUTH_SECRET) {
    return htmlResponse(
      "Discord connection failed",
      "<p>The Discord OAuth secret is not configured on the Worker.</p>",
      500,
      clearStateCookie()
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
        "<p>Discord rejected the authorization exchange. Please start again.</p>",
        502,
        clearStateCookie()
      );
    }

    const token = await tokenResponse.json();

    if (!token.access_token) {
      return htmlResponse(
        "Discord connection failed",
        "<p>Discord did not return an access token.</p>",
        502,
        clearStateCookie()
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
        clearStateCookie()
      );
    }

    const user = await userResponse.json();
    const displayName = user.global_name || user.username || "Discord member";

    return htmlResponse(
      "Discord connected",
      `
        <p><strong>${escapeHtml(displayName)}</strong> is authenticated with Discord.</p>
        <p>Discord user ID: <code>${escapeHtml(user.id || "unknown")}</code></p>
        <p>This proves the Discord OAuth side is working. The XRPL wallet link comes next.</p>
      `,
      200,
      clearStateCookie()
    );
  } catch (err) {
    console.error("Discord OAuth callback error", err);

    return htmlResponse(
      "Discord connection failed",
      "<p>The Worker could not complete the Discord connection. Please try again.</p>",
      500,
      clearStateCookie()
    );
  }
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return "";

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return "";
}

function clearStateCookie() {
  return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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

function htmlResponse(title, body, status = 200, setCookie = "") {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });

  if (setCookie) headers.set("set-cookie", setCookie);

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
