/**
 * Loads data/pets.json and builds lookup indexes.
 *
 * Everything downstream addresses pets by slug via `bySlug`. Array order in
 * pets.json is used for display order only — no state, no storage key, and no
 * backup code depends on it, so pets can be reordered or inserted freely.
 */

const DATA_URL = new URL("../../data/pets.json", import.meta.url);
const CODES_URL = new URL("../../data/codes.json", import.meta.url);

/**
 * The permanent slug -> integer ledger backup codes are indexed by. It is
 * maintained by a GitHub Action, so between a data push and that Action landing
 * there can be pets with no integer yet. That is expected and handled: such
 * pets fall back to being named by slug in backup codes.
 */
async function loadCodes() {
  try {
    const response = await fetch(CODES_URL, { cache: "no-cache" });
    if (!response.ok) return new Map();

    const doc = await response.json();
    const entries = Object.entries(doc?.codes ?? {}).filter(
      ([, code]) => Number.isInteger(code) && code >= 0,
    );
    return new Map(entries);
  } catch {
    // A missing or malformed ledger must never break the tracker.
    return new Map();
  }
}

/**
 * How long a value may be, in characters, before it stops being allowed to set
 * its column's width.
 *
 * Sizing purely off the longest value that exists means one outlier decides the
 * layout for the whole index: a single 25-character pet ("La Vaca Saturno
 * Saturnita") would widen the Pet column in all sixteen worlds, most of which
 * top out around fourteen. These caps are the lengths the dataset had when the
 * current layout was settled on, so the columns keep the widths they have now
 * and anything longer is shrunk to fit instead (see fitScale in ui.js).
 *
 * Deliberately a written-down number rather than something read off the data:
 * the point is that the width does NOT move when the data grows. Raising one is
 * a layout decision — worth doing when a whole batch of new values sits above
 * the cap, since past a point shrinking is worse than a wider column, but not
 * for a single long name.
 */
const WIDTH_CAP = { name: 21, egg: 25, rarity: 10, clicks: 6 };

/**
 * The longest values in the WHOLE dataset, per column, for the layout to reserve
 * width with.
 *
 * A column sized by its own category is a different width in every world, so the
 * table and the filter menus jump every time you switch. Sized by the widest
 * value that exists anywhere, they are identical in all sixteen.
 *
 * Several candidates per column, not one: character count is only a proxy for
 * width, and a shorter string of wide letters can beat a longer one of narrow
 * ones. Everything within two characters of the longest is kept and the browser
 * measures them all (see the sizers in ui.js), which settles it in the real font
 * rather than in an estimate.
 *
 * Values over the column's cap are excluded from that shortlist — they are still
 * displayed in full, just not allowed to be what the column is measured against.
 */
function widestValues(pets) {
  const pick = (values, cap) => {
    const unique = [...new Set(values.filter(Boolean).map(String))];
    if (!unique.length) return [];

    // If everything is over the cap the column has to be sized by something, so
    // fall back to the shortest values available rather than to nothing.
    const eligible = unique.filter((v) => v.length <= cap);
    const pool = eligible.length ? eligible : [minBy(unique, (v) => v.length)];

    const longest = Math.max(...pool.map((v) => v.length));
    return pool
      .filter((v) => v.length >= longest - 2)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 12);
  };

  return {
    name: pick(pets.map((p) => p.name), WIDTH_CAP.name),
    egg: pick(pets.map((p) => p.egg), WIDTH_CAP.egg),
    rarity: pick(pets.map((p) => p.rarity), WIDTH_CAP.rarity),
    clicks: pick(pets.map((p) => p.clicks), WIDTH_CAP.clicks),
  };
}

function minBy(values, score) {
  return values.reduce((best, v) => (score(v) < score(best) ? v : best));
}

export async function loadIndex() {
  const [response, codes] = await Promise.all([
    fetch(DATA_URL, { cache: "no-cache" }),
    loadCodes(),
  ]);

  if (!response.ok) {
    throw new Error(`Could not load pet data (HTTP ${response.status}).`);
  }

  const doc = await response.json();
  if (!doc || !Array.isArray(doc.categories)) {
    throw new Error("Pet data is malformed: expected a `categories` array.");
  }

  const variants = (doc.variants ?? []).map((v) => ({ id: v.id, label: v.label }));
  const bySlug = new Map();
  const byCode = new Map();
  const duplicates = [];

  const categories = doc.categories.map((cat) => {
    const pets = (cat.pets ?? []).map((pet) => {
      const entry = {
        slug: pet.slug,
        name: pet.name,
        egg: pet.egg ?? null,
        rarity: pet.rarity ?? null,
        clicks: pet.clicks ?? null,
        variants: Array.isArray(pet.variants) ? pet.variants : [],
        categoryId: cat.id,
        code: codes.get(pet.slug) ?? null,
      };
      if (bySlug.has(entry.slug)) {
        duplicates.push(entry.slug);
      } else {
        bySlug.set(entry.slug, entry);
        if (entry.code !== null) byCode.set(entry.code, entry);
      }
      return entry;
    });

    return {
      id: cat.id,
      label: cat.label,
      pets,
      // Distinct eggs and rarities, in first-seen order, for the filter menus.
      eggs: [...new Set(pets.map((p) => p.egg).filter(Boolean))],
      rarities: [...new Set(pets.map((p) => p.rarity).filter(Boolean))],
      // Total tickable boxes: pets times the variants that actually exist for them.
      totalTicks: pets.reduce((sum, p) => sum + p.variants.length, 0),
    };
  });

  if (duplicates.length) {
    // Loud rather than silent: a duplicate slug means two pets share one
    // checklist entry, which would corrupt progress for both.
    console.error("Duplicate pet slugs in pets.json:", duplicates);
  }

  return {
    schemaVersion: doc.schemaVersion ?? 1,
    generatedAt: doc.generatedAt ?? null,
    variants,
    categories,
    bySlug,
    byCode,
    duplicates,
    /** Per-column width samples, so every category lays out identically. */
    widest: widestValues([...bySlug.values()]),
    /** Highest integer in use, so the encoder knows how wide a bitset to build. */
    maxCode: byCode.size ? Math.max(...byCode.keys()) : -1,
    totalPets: bySlug.size,
    totalTicks: categories.reduce((sum, c) => sum + c.totalTicks, 0),
  };
}

/** Count ticks a profile has, ignoring slugs and variants not in the data. */
export function countProgress(index, progress) {
  const perVariant = new Map(index.variants.map((v) => [v.id, 0]));
  const perCategory = new Map(index.categories.map((c) => [c.id, 0]));
  let total = 0;

  for (const [slug, caught] of Object.entries(progress)) {
    const pet = index.bySlug.get(slug);
    if (!pet) continue;

    for (const variantId of caught) {
      // A tick only counts if that variant genuinely exists for that pet —
      // otherwise stale data from a removed variant would inflate the total.
      if (!pet.variants.includes(variantId)) continue;
      total += 1;
      perVariant.set(variantId, (perVariant.get(variantId) ?? 0) + 1);
      perCategory.set(pet.categoryId, (perCategory.get(pet.categoryId) ?? 0) + 1);
    }
  }

  return { total, perVariant, perCategory };
}

/** Tickable boxes per variant, across the whole index or one category. */
export function totalsByVariant(index, category) {
  const source = category ? [category] : index.categories;
  const totals = new Map(index.variants.map((v) => [v.id, 0]));

  for (const cat of source) {
    for (const pet of cat.pets) {
      for (const variantId of pet.variants) {
        totals.set(variantId, (totals.get(variantId) ?? 0) + 1);
      }
    }
  }
  return totals;
}
