/**
 * Backup codes — a pasteable snapshot of one profile's ticked pets.
 *
 * Wire format:
 *
 *   RCU1.<base64url>     payload compressed with raw DEFLATE
 *   RCU1U.<base64url>    payload uncompressed (fallback for old browsers)
 *
 * Payload v3, as UTF-8 text:
 *
 *   3                              <- payload version
 *   <profile name>
 *   normal,golden,toxic,galaxy     <- variant alphabet, declared inline
 *   <base64url bitset>             <- ticks for pets that have an integer code
 *   <shared><suffix>|<indices>     <- optional tail: pets with no code yet
 *   ...
 *
 * Spelling out slugs costs kilobytes; the tick data itself is only a few
 * hundred bytes. So ticks are stored as a bitset indexed by each pet's
 * permanent integer from data/codes.json:
 *
 *     bit index = pet.code * alphabet.length + variantIndex
 *
 * Those integers are permanent and never reused (see tools/assign_codes.py),
 * which is what makes this safe: adding pets only appends higher integers, so
 * every backup code ever issued keeps decoding correctly, and a removed pet's
 * slot can never be reinterpreted as a different pet.
 *
 * The tail exists because data/codes.json is written by a GitHub Action that
 * lands a moment after a data push. In that window a pet has no integer yet, so
 * its ticks are named by slug instead — front-coded (each line records how many
 * leading characters it shares with the previous slug) and referring to the
 * inline alphabet by base-36 index. This is also the whole of the older v2
 * format, which is still read below.
 *
 * The alphabet is declared *inside the payload*, so an index in a saved code can
 * never be reinterpreted by a later change to pets.json.
 *
 * Nothing here is keyed by position in pets.json, so reordering or inserting
 * pets cannot invalidate a code. Entries that cannot be resolved are reported
 * to the user at import rather than silently dropped.
 */

const PREFIX_DEFLATE = "RCU1.";
const PREFIX_PLAIN = "RCU1U.";
const PAYLOAD_VERSION = "3";

/** Front coding caps the shared-prefix length at one base-36 digit. */
const MAX_SHARED = 35;

/* ---------- base64url ---------- */

function bytesToBase64Url(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------- compression ---------- */

const canCompress = typeof CompressionStream === "function";
const canDecompress = typeof DecompressionStream === "function";

async function streamThrough(bytes, stream) {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

/* ---------- payload ---------- */

function cleanName(profileName) {
  return String(profileName ?? "").replace(/[\r\n]+/g, " ").trim();
}

/** Emit `<shared><suffix>|<indices>` lines for slugs that have no integer code. */
function frontCodeLines(slugs, progress, indexOf) {
  const lines = [];
  let previous = "";

  for (const slug of slugs) {
    let shared = 0;
    const limit = Math.min(previous.length, slug.length, MAX_SHARED);
    while (shared < limit && previous[shared] === slug[shared]) shared += 1;

    const indices = [...new Set(progress[slug])]
      .map((variant) => indexOf.get(variant).toString(36))
      .sort()
      .join("");

    lines.push(`${shared.toString(36)}${slug.slice(shared)}|${indices}`);
    previous = slug;
  }
  return lines;
}

function buildPayload(profileName, progress, index) {
  // Sorted so front coding has long shared prefixes to exploit, and so identical
  // progress always produces an identical code.
  const slugs = Object.keys(progress)
    .filter((slug) => Array.isArray(progress[slug]) && progress[slug].length)
    .sort();

  // Alphabet in first-seen order, written into the payload so decoding never
  // needs to consult pets.json.
  const alphabet = [];
  const indexOf = new Map();
  for (const slug of slugs) {
    for (const variant of progress[slug]) {
      if (!indexOf.has(variant)) {
        indexOf.set(variant, alphabet.length);
        alphabet.push(variant);
      }
    }
  }
  if (alphabet.length > 36) {
    throw new Error("Too many distinct variants to encode into a backup code.");
  }

  const coded = [];
  const uncoded = [];
  for (const slug of slugs) {
    const code = index?.bySlug.get(slug)?.code;
    if (Number.isInteger(code)) coded.push([code, slug]);
    else uncoded.push(slug);
  }

  // Width the bitset to the highest ticked pet, not the whole index — a player
  // early in the game gets a much shorter code.
  const width = alphabet.length;
  const highest = coded.reduce((max, [code]) => Math.max(max, code), -1);
  const bits = new Uint8Array(Math.ceil(((highest + 1) * width) / 8));

  for (const [code, slug] of coded) {
    for (const variant of new Set(progress[slug])) {
      const bit = code * width + indexOf.get(variant);
      bits[bit >> 3] |= 1 << (bit & 7);
    }
  }

  return [
    PAYLOAD_VERSION,
    cleanName(profileName),
    alphabet.join(","),
    bytesToBase64Url(bits),
    ...frontCodeLines(uncoded, progress, indexOf),
  ].join("\n");
}

/** v1 codes: one `slug|variant,variant` line per pet, no alphabet, no front coding. */
function parsePayloadV1(lines) {
  const name = (lines.shift() ?? "").trim();
  const progress = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    const split = line.indexOf("|");
    if (split < 1) continue;

    const slug = line.slice(0, split).trim();
    const variants = line
      .slice(split + 1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    if (slug && variants.length) progress[slug] = [...new Set(variants)];
  }
  return { name, progress };
}

/** Decode front-coded `<shared><suffix>|<indices>` lines into a progress object. */
function readFrontCoded(lines, alphabet, progress) {
  let previous = "";

  for (const line of lines) {
    if (!line.trim()) continue;

    const split = line.indexOf("|");
    if (split < 1) continue;

    const shared = parseInt(line[0], 36);
    if (Number.isNaN(shared) || shared > previous.length) {
      throw new Error("That backup code is damaged. It may have been truncated when copied.");
    }

    const slug = previous.slice(0, shared) + line.slice(1, split);
    const variants = [...line.slice(split + 1)]
      .map((char) => alphabet[parseInt(char, 36)])
      .filter(Boolean);

    if (slug && variants.length) progress[slug] = [...new Set(variants)];
    previous = slug;
  }
  return progress;
}

function parsePayloadV2(lines) {
  const name = (lines.shift() ?? "").trim();
  const alphabet = (lines.shift() ?? "").split(",").map((v) => v.trim());
  return { name, progress: readFrontCoded(lines, alphabet, {}) };
}

function parsePayloadV3(lines, index) {
  const name = (lines.shift() ?? "").trim();
  const alphabet = (lines.shift() ?? "").split(",").map((v) => v.trim());
  const encoded = (lines.shift() ?? "").trim();

  const width = alphabet.length;
  if (!width) throw new Error("That backup code is missing its variant list.");

  const progress = {};
  const bits = encoded ? base64UrlToBytes(encoded) : new Uint8Array(0);

  for (let bit = 0; bit < bits.length * 8; bit += 1) {
    if (!(bits[bit >> 3] & (1 << (bit & 7)))) continue;

    const variant = alphabet[bit % width];
    if (!variant) continue;

    // An integer with no pet means the code predates a pet's removal. Give it a
    // placeholder slug so the import reports it as skipped instead of dropping
    // it silently or, worse, attaching it to whatever pet now sits nearby.
    const code = Math.floor(bit / width);
    const slug = index?.byCode.get(code)?.slug ?? `#code-${code}`;

    (progress[slug] ??= []).push(variant);
  }

  // Remaining lines are pets that had no integer when the code was made.
  readFrontCoded(lines, alphabet, progress);
  return { name, progress };
}

function parsePayload(text, index) {
  const lines = text.split("\n");
  const version = lines.shift();

  if (version === "1") return parsePayloadV1(lines);
  if (version === "2") return parsePayloadV2(lines);
  if (version === "3") return parsePayloadV3(lines, index);

  throw new Error(`That code was created by a newer version of the tracker (v${version}).`);
}

/* ---------- public API ---------- */

/**
 * @param {string} profileName
 * @param {Record<string, string[]>} progress
 * @param {object} index Loaded pet index; supplies each pet's permanent integer.
 * @returns {Promise<string>} the pasteable backup code
 */
export async function encodeBackup(profileName, progress, index) {
  const bytes = new TextEncoder().encode(buildPayload(profileName, progress, index));

  if (canCompress) {
    try {
      const packed = await streamThrough(bytes, new CompressionStream("deflate-raw"));
      return PREFIX_DEFLATE + bytesToBase64Url(packed);
    } catch {
      // Fall through to the uncompressed form.
    }
  }
  return PREFIX_PLAIN + bytesToBase64Url(bytes);
}

/**
 * @param {string} code
 * @param {object} index Loaded pet index; maps integers back to pet slugs.
 * @returns {Promise<{name: string, progress: Record<string, string[]>}>}
 * @throws {Error} with a message safe to show the user
 */
export async function decodeBackup(code, index) {
  // Be forgiving: people paste these out of Discord, with wrapping and stray spaces.
  const cleaned = String(code ?? "").replace(/\s+/g, "").trim();
  if (!cleaned) throw new Error("Paste a backup code first.");

  let body;
  let compressed;

  if (cleaned.startsWith(PREFIX_PLAIN)) {
    body = cleaned.slice(PREFIX_PLAIN.length);
    compressed = false;
  } else if (cleaned.startsWith(PREFIX_DEFLATE)) {
    body = cleaned.slice(PREFIX_DEFLATE.length);
    compressed = true;
  } else {
    throw new Error("That does not look like a backup code. Backup codes begin with \"RCU1\".");
  }

  let bytes;
  try {
    bytes = base64UrlToBytes(body);
  } catch {
    throw new Error("That backup code is damaged. It may have been truncated when copied.");
  }

  if (compressed) {
    if (!canDecompress) {
      throw new Error("This browser cannot read compressed backup codes.");
    }
    try {
      bytes = await streamThrough(bytes, new DecompressionStream("deflate-raw"));
    } catch {
      throw new Error("That backup code is damaged. It may have been truncated when copied.");
    }
  }

  return parsePayload(new TextDecoder().decode(bytes), index);
}

/**
 * Split imported progress into slugs the current data knows about and slugs it
 * does not, so the UI can tell the user rather than dropping ticks silently.
 */
export function partitionKnown(progress, isKnownSlug) {
  const known = {};
  const unknown = [];

  for (const [slug, variants] of Object.entries(progress)) {
    if (isKnownSlug(slug)) known[slug] = variants;
    else unknown.push(slug);
  }
  return { known, unknown };
}
