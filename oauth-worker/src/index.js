const NOTION_VERSION = "2026-03-11";
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function extensionOrigin(env) {
  return `chrome-extension://${env.EXTENSION_ID}`;
}

function extensionRedirect(env) {
  return `https://${env.EXTENSION_ID}.chromiumapp.org/`;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (origin === extensionOrigin(env)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env)
    }
  });
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirectToExtension(env, state, { error, grant } = {}) {
  const target = new URL(extensionRedirect(env));
  const fragment = new URLSearchParams();
  if (state) fragment.set("state", state);
  if (error) fragment.set("error", error);
  if (grant) fragment.set("grant", encodeBase64Url(grant));
  target.hash = fragment.toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function isAllowedExtensionRequest(request, env) {
  return request.headers.get("Origin") === extensionOrigin(env);
}

function authHeaders(env) {
  const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION
  };
}

async function notionTokenRequest(env, body) {
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Notion OAuth failed (${response.status})`);
  return payload;
}

async function handleCallback(request, env) {
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const state = query.get("state") || "";
  const oauthError = query.get("error");
  if (!STATE_PATTERN.test(state)) return redirectToExtension(env, "", { error: "invalid_state" });
  if (oauthError) return redirectToExtension(env, state, { error: oauthError });
  if (!code) return redirectToExtension(env, state, { error: "missing_code" });

  try {
    const tokens = await notionTokenRequest(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: env.NOTION_REDIRECT_URI
    });
    const grant = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      workspace_name: tokens.workspace_name,
      workspace_id: tokens.workspace_id,
      workspace_icon: tokens.workspace_icon,
      bot_id: tokens.bot_id
    };
    return redirectToExtension(env, state, { grant });
  } catch {
    return redirectToExtension(env, state, { error: "token_exchange_failed" });
  }
}

async function handleRefresh(request, env) {
  if (!isAllowedExtensionRequest(request, env)) return json({ error: "forbidden_origin" }, 403, request, env);
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request, env); }
  if (!payload?.refresh_token) return json({ error: "missing_refresh_token" }, 400, request, env);
  try {
    const tokens = await notionTokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: payload.refresh_token
    });
    return json(tokens, 200, request, env);
  } catch (error) {
    return json({ error: "refresh_failed", message: error.message }, 401, request, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const url = new URL(request.url);
    if (url.pathname === "/oauth/callback" && request.method === "GET") return handleCallback(request, env);
    if (url.pathname === "/oauth/refresh" && request.method === "POST") return handleRefresh(request, env);
    return json({ error: "not_found" }, 404, request, env);
  }
};
