/**
 * Local-first storage.
 *
 * localStorage is the SOURCE OF TRUTH for progress. Every read and write in this
 * module completes against localStorage alone and never awaits the network.
 *
 * Storage shape
 * -------------
 *   rcu:v1:profiles            -> [{ id, name, createdAt }]
 *   rcu:v1:activeProfile       -> profileId
 *   rcu:v1:progress:<id>       -> { "<pet-slug>": ["normal", "golden"] }
 *
 * Progress is keyed by pet slug and variant id — never by array position — so
 * reordering or inserting pets in pets.json cannot disturb saved progress.
 * Profiles carry an internal id so a profile can be renamed without orphaning
 * its checklist.
 */

const NS = "rcu:v1";
const KEY_PROFILES = `${NS}:profiles`;
const KEY_ACTIVE = `${NS}:activeProfile`;
const keyProgress = (profileId) => `${NS}:progress:${profileId}`;

export const MAX_NAME_LENGTH = 40;

/**
 * The availability probe writes and deletes this key on every single read, and
 * every one of those writes raises a `storage` event in the site's other tabs.
 * A listener that re-renders on it will make the other tab probe in turn, and
 * the two will bounce re-renders off each other forever — so `storage`
 * listeners must skip this key.
 */
export const PROBE_KEY = `${NS}:probe`;

/** localStorage can be absent or throw (private mode, disabled cookies). */
function backing() {
  try {
    window.localStorage.setItem(PROBE_KEY, "1");
    window.localStorage.removeItem(PROBE_KEY);
    return window.localStorage;
  } catch {
    return null;
  }
}

const memoryFallback = new Map();

function readRaw(key) {
  const store = backing();
  if (store) return store.getItem(key);
  return memoryFallback.has(key) ? memoryFallback.get(key) : null;
}

function writeRaw(key, value) {
  const store = backing();
  if (store) {
    try {
      store.setItem(key, value);
      return true;
    } catch {
      // Quota exceeded — fall through to memory so the session still works.
    }
  }
  memoryFallback.set(key, value);
  return false;
}

function removeRaw(key) {
  const store = backing();
  if (store) store.removeItem(key);
  memoryFallback.delete(key);
}

function readJSON(key, fallback) {
  const raw = readRaw(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function makeId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeName(name) {
  return String(name ?? "").trim().slice(0, MAX_NAME_LENGTH);
}

/** Names are compared case-insensitively so "Paints" and "paints" are one profile. */
function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

export class Store {
  constructor() {
    this.listeners = new Set();
    this.storageAvailable = backing() !== null;
  }

  /* ---------- change notification ---------- */

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  /* ---------- profiles ---------- */

  listProfiles() {
    const list = readJSON(KEY_PROFILES, []);
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && typeof p.id === "string" && typeof p.name === "string");
  }

  saveProfiles(list) {
    writeRaw(KEY_PROFILES, JSON.stringify(list));
  }

  findProfileByName(name) {
    const key = nameKey(name);
    return this.listProfiles().find((p) => nameKey(p.name) === key) ?? null;
  }

  getProfile(id) {
    return this.listProfiles().find((p) => p.id === id) ?? null;
  }

  /**
   * Create a profile, or return the existing one if the name is already taken.
   * @returns {{profile: object, created: boolean}}
   */
  createProfile(name) {
    const clean = normalizeName(name);
    if (!clean) throw new Error("Profile name cannot be empty.");

    const existing = this.findProfileByName(clean);
    if (existing) return { profile: existing, created: false };

    const profile = { id: makeId(), name: clean, createdAt: new Date().toISOString() };
    const list = this.listProfiles();
    list.push(profile);
    this.saveProfiles(list);
    this.emit({ type: "profiles" });
    return { profile, created: true };
  }

  renameProfile(id, name) {
    const clean = normalizeName(name);
    if (!clean) throw new Error("Profile name cannot be empty.");

    const clash = this.findProfileByName(clean);
    if (clash && clash.id !== id) throw new Error(`A profile named "${clean}" already exists.`);

    const list = this.listProfiles();
    const profile = list.find((p) => p.id === id);
    if (!profile) throw new Error("That profile no longer exists.");

    profile.name = clean;
    this.saveProfiles(list);
    this.emit({ type: "profiles" });
    return profile;
  }

  deleteProfile(id) {
    const list = this.listProfiles().filter((p) => p.id !== id);
    this.saveProfiles(list);
    removeRaw(keyProgress(id));
    if (this.getActiveProfileId() === id) {
      this.setActiveProfileId(list[0]?.id ?? null);
    }
    this.emit({ type: "profiles" });
  }

  getActiveProfileId() {
    const id = readRaw(KEY_ACTIVE);
    if (id && this.getProfile(id)) return id;
    return this.listProfiles()[0]?.id ?? null;
  }

  setActiveProfileId(id) {
    if (id) writeRaw(KEY_ACTIVE, id);
    else removeRaw(KEY_ACTIVE);
    this.emit({ type: "activeProfile", profileId: id });
  }

  /* ---------- progress ---------- */

  /** @returns {Record<string, string[]>} slug -> caught variant ids */
  getProgress(profileId) {
    if (!profileId) return {};
    const raw = readJSON(keyProgress(profileId), {});
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

    const clean = {};
    for (const [slug, variants] of Object.entries(raw)) {
      if (!Array.isArray(variants)) continue;
      const ids = [...new Set(variants.filter((v) => typeof v === "string"))];
      if (ids.length) clean[slug] = ids;
    }
    return clean;
  }

  setProgress(profileId, progress) {
    if (!profileId) return;
    writeRaw(keyProgress(profileId), JSON.stringify(progress));
    this.emit({ type: "progress", profileId });
  }

  isCaught(profileId, slug, variantId) {
    return this.getProgress(profileId)[slug]?.includes(variantId) ?? false;
  }

  /**
   * Tick or untick one variant of one pet. This is the hot path — one pet slug
   * plus one variant id, with no dependence on the pet's position in the data.
   */
  setCaught(profileId, slug, variantId, caught) {
    if (!profileId) return;
    const progress = this.getProgress(profileId);
    const current = new Set(progress[slug] ?? []);

    if (caught) current.add(variantId);
    else current.delete(variantId);

    if (current.size) progress[slug] = [...current];
    else delete progress[slug];

    writeRaw(keyProgress(profileId), JSON.stringify(progress));
    this.emit({ type: "progress", profileId, slug, variantId, caught });
  }

  /**
   * Tick or untick many pet+variant pairs in ONE write.
   *
   * setCaught is O(storage) per box: every call re-runs the availability probe
   * (two localStorage writes), re-parses the whole progress object, re-serialises
   * it, writes it back, and raises a `storage` event in every other tab. Marking
   * Exclusives' 792 boxes through it is ~1,584 probe writes, 792 parses of a
   * ~40 KB document, and 792 events for other tabs to re-render on. Here it is
   * one of each.
   *
   * Boxes already in the requested state are skipped, so the return value is the
   * number that genuinely moved. No caller needs it today — the table and the
   * counts are the feedback — but the early return it guards does matter: see
   * below.
   *
   * @param {string} profileId
   * @param {Array<{slug: string, variantId: string}>} changes
   * @param {boolean} caught
   * @returns {number} boxes actually changed
   */
  setManyCaught(profileId, changes, caught) {
    if (!profileId || !changes?.length) return 0;

    const progress = this.getProgress(profileId);
    let changed = 0;

    for (const { slug, variantId } of changes) {
      const current = new Set(progress[slug] ?? []);
      const before = current.size;

      if (caught) current.add(variantId);
      else current.delete(variantId);
      if (current.size === before) continue; // already in the requested state

      changed += 1;
      if (current.size) progress[slug] = [...current];
      else delete progress[slug];
    }

    // Nothing moved: no write, no storage event, and no undo entry offered
    // against a change that never happened.
    if (!changed) return 0;

    writeRaw(keyProgress(profileId), JSON.stringify(progress));
    this.emit({ type: "progress", profileId, bulk: changed });
    return changed;
  }

  /** Union of existing progress and incoming progress. Used by backup import. */
  mergeProgress(profileId, incoming) {
    const progress = this.getProgress(profileId);
    let added = 0;

    for (const [slug, variants] of Object.entries(incoming)) {
      const current = new Set(progress[slug] ?? []);
      const before = current.size;
      for (const v of variants) current.add(v);
      added += current.size - before;
      if (current.size) progress[slug] = [...current];
    }

    this.setProgress(profileId, progress);
    return added;
  }
}
