/**
 * CORS proxy for the RCU Index Tracker's "Import from game" feature.
 *
 * Browsers will not let the tracker call public-api.powerfulstudio.xyz or
 * Roblox's username lookup directly: neither sends CORS headers. This Worker
 * makes those calls on the browser's behalf and adds the headers.
 *
 *   GET /player?user=<roblox username or numeric id>
 *       header: X-Access-Token
 *       -> { userId, name, index: ["100mballoon:1", ...] }
 *
 * The token is forwarded upstream as a header and is never stored, cached or
 * logged. Nothing is persisted. Only the tracker's own origins may call it.
 */

const API = "https://public-api.powerfulstudio.xyz";
const ROBLOX_USERS = "https://users.roblox.com/v1/usernames/users";
const ROBLOX_PROFILE = "https://www.roblox.com/users/profile";

const ALLOWED_ORIGINS = new Set([
  "https://paints18.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
]);

const MAX_TOKEN_LENGTH = 200;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER = 60;
const MAX_RETRY_AFTER = 3600;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "X-Access-Token",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(origin, status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

/** Retry-After as whole seconds, whatever the upstream sent (it may be a date or junk). */
function retryAfterSeconds(value) {
  const wait = Math.ceil(Number(value));
  if (!value?.trim() || !Number.isFinite(wait) || wait < 1) return String(DEFAULT_RETRY_AFTER);
  return String(Math.min(wait, MAX_RETRY_AFTER));
}

/** The id goes into the upstream URL path, so only a plain positive integer is accepted. */
const USER_ID_RE = /^[1-9]\d{0,19}$/;

/** Username lookup through Roblox's users API. Resolves to { id, name }, or null when no such user. */
async function lookupByUsersApi(username) {
  const res = await fetch(ROBLOX_USERS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw Object.assign(new Error("roblox 429"), { rateLimited: true });
  if (!res.ok) throw new Error(`roblox ${res.status}`);

  const found = (await res.json())?.data?.[0];
  const id = String(found?.id ?? "");
  return USER_ID_RE.test(id) ? { id, name: typeof found.name === "string" ? found.name : null } : null;
}

/**
 * Username lookup through the roblox.com profile redirect, which answers with a
 * 302 to /users/<id>/profile, or to /request-error?code=404 for an unknown name.
 * It is a different service from the users API, so it is tried when that one
 * refuses. Resolves to { id, name: null }, or null when no such user.
 */
async function lookupByProfileRedirect(username) {
  const res = await fetch(`${ROBLOX_PROFILE}?username=${encodeURIComponent(username)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
  if (!location) throw new Error(`roblox profile ${res.status}`);

  const target = new URL(location, ROBLOX_PROFILE);
  const id = target.pathname.match(/^\/users\/(\d+)\/profile\/?$/)?.[1];
  if (id && USER_ID_RE.test(id)) return { id, name: null };
  if (target.pathname === "/request-error" && target.searchParams.get("code") === "404") return null;
  throw new Error(`roblox profile redirect to ${target.pathname}`);
}

/**
 * Resolve a username to { id, name }, or pass a numeric id straight through.
 *
 * Roblox rate limits the users API by IP, and Workers call out from addresses
 * shared with every other Worker, so that API refuses most lookups from here
 * with a 429 even at one request an hour. The profile redirect is the fallback.
 * When both fail, the users API's error is the one thrown.
 */
async function resolveUser(input) {
  if (/^\d{1,20}$/.test(input)) return { id: input, name: null };
  if (!USERNAME_RE.test(input)) return null;

  let primaryError;
  try {
    return await lookupByUsersApi(input);
  } catch (error) {
    primaryError = error;
  }
  try {
    return await lookupByProfileRedirect(input);
  } catch {
    throw primaryError;
  }
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";
    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/player") {
      return reply(origin, 404, { error: "Not found" });
    }

    const token = (request.headers.get("X-Access-Token") ?? "").trim();
    if (!token) return reply(origin, 400, { error: "Enter your access token." });
    if (token.length > MAX_TOKEN_LENGTH) return reply(origin, 400, { error: "That access token is too long." });

    const input = (url.searchParams.get("user") ?? "").trim();
    if (!input) return reply(origin, 400, { error: "Enter your Roblox username or user ID." });
    let user;
    try {
      user = await resolveUser(input);
    } catch (error) {
      // No Retry-After: waiting rarely helps (see resolveUser), the user ID does.
      if (error.rateLimited) {
        return reply(origin, 429, {
          error: "Roblox is rate limiting name lookups. Enter your user ID instead: the number in your Roblox profile link.",
        });
      }
      return reply(origin, 502, { error: "Roblox could not be reached. Try again shortly." });
    }
    if (!user) {
      return reply(origin, 404, { error: "No Roblox user found with that name or ID." });
    }

    let upstream;
    try {
      upstream = await fetch(`${API}/rcu/v1/players/${user.id}?include=index`, {
        headers: { Accept: "application/json", "X-Access-Token": token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return reply(origin, 502, { error: "The Powerful Studio API could not be reached." });
    }

    if (upstream.status === 429) {
      const wait = retryAfterSeconds(upstream.headers.get("Retry-After"));
      return reply(origin, 429, { error: "Rate limited. Wait a moment and try again." }, { "Retry-After": wait });
    }
    if (upstream.status === 401 || upstream.status === 403 || upstream.status === 400) {
      return reply(origin, 401, { error: "The API rejected that token or user. Check both and try again." });
    }
    if (upstream.status === 404) {
      return reply(origin, 404, { error: "The API has no index for that user." });
    }
    if (!upstream.ok) {
      return reply(origin, 502, { error: `The API returned an error (${upstream.status}).` });
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      return reply(origin, 502, { error: "The API sent an unreadable response." });
    }
    if (!Array.isArray(data?.index)) {
      return reply(origin, 502, { error: "The API response had no pet index." });
    }

    return reply(origin, 200, { userId: user.id, name: user.name, index: data.index });
  },
};
