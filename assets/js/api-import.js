/**
 * Import a profile's index from the Powerful Studio API.
 *
 * The browser cannot call that API (or Roblox's username lookup) directly: neither
 * sends CORS headers. The request goes through a small proxy Worker, whose source
 * is in worker/index.js, which forwards it and adds them. The token travels as a
 * header, is not stored or logged by the Worker, and is kept in this browser only
 * so a linked profile can refresh itself.
 *
 * The API names a pet by a squashed key ("100mballoon") and a tier number, as
 * `100mballoon:2` with an optional trailing `:s`. Pets here are addressed by slug,
 * so each key is matched to a pet by squashing its display name the same way.
 */

export const PROXY_URL = "https://rcu-index-proxy.xpoprod2.workers.dev";

/** API tier number -> variant id in data/pets.json. */
const TIER_VARIANT = { 1: "normal", 2: "golden", 3: "toxic", 4: "galaxy" };

/** Longest wait shown for a rate limit, and the most the Worker accepts for a token. */
const MAX_RETRY_SECONDS = 3600;
const MAX_TOKEN_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 20_000;

/** Tiers the tracker has no column for. Those entries are dropped without being counted or reported. */
const IGNORED_TIERS = new Set(["5"]);

/**
 * Pets the API reports that the tracker deliberately does not list. They are
 * skipped silently instead of being reported as missing on every import.
 */
const IGNORED_KEYS = new Set(["clantutel", "nuclearcow", "spacetutel", "theegg"]);

const squash = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Error carrying a message that is safe to show, and how long to wait if rate limited. */
export class ApiImportError extends Error {
  constructor(message, retryAfter = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** Fetch the raw index entries for one player. */
export async function fetchPlayerIndex({ user, token } = {}) {
  const cleanUser = String(user ?? "").trim();
  const cleanToken = String(token ?? "").trim();
  if (!cleanUser) throw new ApiImportError("Enter your Roblox username or user ID.");
  if (!cleanToken) throw new ApiImportError("Enter your access token.");
  // Header values must be printable ASCII; anything else makes fetch throw before it sends.
  if (cleanToken.length > MAX_TOKEN_LENGTH || !/^[!-~]+(?: [!-~]+)*$/.test(cleanToken)) {
    throw new ApiImportError("That access token looks wrong. Copy it again from the API page.");
  }

  let response;
  try {
    response = await fetch(`${PROXY_URL}/player?user=${encodeURIComponent(cleanUser)}`, {
      headers: { "X-Access-Token": cleanToken },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiImportError("Could not reach the import service. Check your connection and try again.");
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Handled below by status.
  }

  if (response.status === 429) {
    const wait = Math.ceil(Number(response.headers.get("Retry-After")));
    const seconds = Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_RETRY_SECONDS) : null;
    throw new ApiImportError(
      seconds ? `Rate limited. Try again in ${seconds} seconds.` : "Rate limited. Try again in a moment.",
      seconds,
    );
  }
  if (!response.ok || !Array.isArray(body?.index)) {
    // The message is shown to the person, so only a short, non-empty string is trusted.
    const message = typeof body?.error === "string" ? body.error.trim() : "";
    throw new ApiImportError(
      message && message.length <= 200
        ? message
        : response.ok
          ? "The import service sent an unexpected response."
          : `The import service returned an error (${response.status}).`,
    );
  }
  return body;
}

/**
 * Turn raw API entries into tracker progress.
 *
 * Nothing is guessed: an entry whose name matches no pet, or more than one, is
 * reported as unmatched rather than attached to the nearest candidate.
 *
 * @returns {{progress: Record<string, string[]>, unmatched: string[], unsupported: number}}
 */
export function entriesToProgress(entries, index) {
  const bySquashed = new Map();
  const ambiguous = new Set();
  for (const pet of index.bySlug.values()) {
    const key = squash(pet.name);
    if (bySquashed.has(key)) ambiguous.add(key);
    else bySquashed.set(key, pet);
  }

  // A Map, so no slug can collide with Object.prototype members.
  const progress = new Map();
  const unmatched = new Set();
  let unsupported = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const parts = typeof entry === "string" ? entry.split(":").map((part) => part.trim()) : [];
    if (IGNORED_TIERS.has(parts[1])) continue;
    const variant = Object.hasOwn(TIER_VARIANT, parts[1]) ? TIER_VARIANT[parts[1]] : undefined;
    const wellFormed = parts.length === 2 || (parts.length === 3 && parts[2].toLowerCase() === "s");
    if (!wellFormed || !variant) {
      unsupported += 1;
      continue;
    }

    const key = squash(parts[0]);
    if (!key) {
      unsupported += 1;
      continue;
    }
    if (IGNORED_KEYS.has(key)) continue;

    const pet = ambiguous.has(key) ? null : bySquashed.get(key);
    if (!pet) {
      unmatched.add(parts[0]);
      continue;
    }
    // The API can list a tier the tracker does not show for that pet.
    if (!pet.variants?.includes(variant)) {
      unsupported += 1;
      continue;
    }

    const list = progress.get(pet.slug) ?? [];
    if (!list.includes(variant)) list.push(variant);
    progress.set(pet.slug, list);
  }

  return { progress: Object.fromEntries(progress), unmatched: [...unmatched], unsupported };
}
