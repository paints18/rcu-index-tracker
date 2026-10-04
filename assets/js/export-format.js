/**
 * The export pipeline, with no DOM in it: scope picks the pets, filters trim them,
 * and a formatter turns what is left into text or a sheet.
 *
 * Everything comes in through one `ctx` object so it can be run on its own:
 *
 *   index     the loaded pet index (categories, variants)
 *   progress  slug -> caught variant ids
 *   prefs     the dialog's options (see DEFAULT_PREFS in export-modal.js)
 *   pagePets  the pets the page is showing right now, or null to use the
 *             categories / sources / rarities in prefs instead
 */

export const SEPARATORS = [
  { id: "comma", label: "Comma (Golden, Toxic)", join: ", " },
  { id: "slash", label: "Slash (Golden/Toxic)", join: "/" },
];

/**
 * Only 4 variants exist in the whole dataset, so a hand-picked map reads
 * better than deriving codes from the label (e.g. Golden and Galaxy both
 * start with G).
 */
const ABBREVIATIONS = { normal: "N", golden: "G", toxic: "T", galaxy: "Gal" };

/**
 * What a spreadsheet cell holds. A caught variant gets a tick; a missing one is
 * left blank, so the sheet reads as a filled-in checklist; and a variant the pet
 * does not have gets a dash, so "no such variant" is not mistaken for "not caught
 * yet".
 */
const CAUGHT_MARK = "✓";
const NOT_AVAILABLE = "-";

/** A pet with no usable source ("-" is the data's placeholder for none). */
const hasSource = (pet) => Boolean(pet.source) && pet.source !== "-";

/**
 * `[{ id, label, pets }]`, one per category with pets left, in the index's order.
 * The virtual "All" category is never walked: it holds the same pet objects as
 * every other category, so doing so would export everything twice.
 */
function scopedGroups({ index, prefs, pagePets }) {
  const real = index.categories.filter((c) => !c.virtual);

  if (pagePets) {
    const onPage = new Set(pagePets);
    return real
      .map((c) => ({ id: c.id, label: c.label, pets: c.pets.filter((p) => onPage.has(p)) }))
      .filter((g) => g.pets.length);
  }

  const categories = new Set(prefs.categories);
  const sources = new Set(prefs.sources);
  const rarities = new Set(prefs.rarities);
  return real
    .filter((c) => !categories.size || categories.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.label,
      pets: c.pets.filter(
        (p) => (!sources.size || sources.has(p.source)) && (!rarities.size || rarities.has(p.rarity ?? "")),
      ),
    }))
    .filter((g) => g.pets.length);
}

/**
 * Apply the mode and the variant filter: `[{ id, label, entries: [{ pet, variants }] }]`,
 * where `variants` are the ids that made the cut. Pets with none left, and groups
 * with no pets left, are dropped.
 */
function collect(ctx) {
  const { prefs, progress } = ctx;
  const wantCaught = prefs.mode === "have";
  const skipVariants = new Set(prefs.excludedVariants);
  const groups = [];

  for (const { id, label, pets } of scopedGroups(ctx)) {
    const entries = [];
    for (const pet of pets) {
      const caught = progress[pet.slug] ?? [];
      const variants = pet.variants.filter(
        (v) => !skipVariants.has(v) && (prefs.mode === "all" || caught.includes(v) === wantCaught),
      );
      if (variants.length) entries.push({ pet, variants });
    }
    if (entries.length) groups.push({ id, label, entries });
  }
  return groups;
}

/** A cell, quoted when it holds the delimiter, a quote or a line break. */
function sheetCell(value, delimiter) {
  const text = value == null ? "" : String(value);
  const special = text.includes(delimiter) || /["\r\n]/.test(text);
  return special ? `"${text.replace(/"/g, '""')}"` : text;
}

const toDelimited = (rows, delimiter) =>
  rows.map((row) => row.map((c) => sheetCell(c, delimiter)).join(delimiter)).join("\n");

/**
 * Re-delimit the sheet text (tab-separated, which is what gets copied) as CSV (which
 * is what gets downloaded). Done on the text rather than the data so that hand
 * edits made in the preview come along.
 */
export function tsvToCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return toDelimited(rows, ",");
}

/** "Dog", or "Dog (Common, Basic Egg)" with the Rarity and Source toggles on. */
function petLabel(pet, prefs) {
  const bits = [];
  if (prefs.showRarity && pet.rarity) bits.push(pet.rarity);
  if (prefs.showSource && hasSource(pet)) bits.push(pet.source);
  return bits.length ? `${pet.name} (${bits.join(", ")})` : pet.name;
}

function formatText(groups, { index, prefs }) {
  const labels = new Map(index.variants.map((v) => [v.id, v.label]));
  const variantName = (id) => (prefs.abbreviate ? ABBREVIATIONS[id] : null) ?? labels.get(id) ?? id;
  // Abbreviated names are short enough to run together: "N,G,T" rather than "N, G, T".
  const joined = SEPARATORS.find((s) => s.id === prefs.separator)?.join ?? ", ";
  const join = prefs.abbreviate ? joined.trim() : joined;

  // Without the category header there is nothing to keep the groups apart, so
  // they run together as one list.
  const sections = prefs.showCategory
    ? groups
    : [{ label: "", entries: groups.flatMap((g) => g.entries) }];

  return sections
    .map(({ label, entries }) => {
      const lines = entries.map(
        ({ pet, variants }) => `${petLabel(pet, prefs)} - ${variants.map(variantName).join(join)}`,
      );
      return (label ? [label, ...lines] : lines).join("\n");
    })
    .join("\n\n");
}

/**
 * One row per pet and one column per variant, like the list view; a caught variant
 * gets the mark and a missing one stays blank. The List option picks the rows.
 * Columns nobody in the table has (say Galaxy, in a category with no Galaxy pets)
 * are left out.
 */
function sheetRows(entries, { index, progress, prefs }, { category }) {
  const skip = new Set(prefs.excludedVariants);
  const columns = index.variants.filter(
    (v) => !skip.has(v.id) && entries.some(({ pet }) => pet.variants.includes(v.id)),
  );
  const worldOf = new Map(index.categories.map((c) => [c.id, c.label]));

  const rows = [
    [
      ...(category ? ["Category"] : []),
      "Pet",
      ...(prefs.showSource ? ["Source"] : []),
      ...(prefs.showRarity ? ["Rarity"] : []),
      ...columns.map((v) => v.label),
    ],
  ];
  for (const { pet } of entries) {
    const caught = progress[pet.slug] ?? [];
    rows.push([
      ...(category ? [worldOf.get(pet.categoryId)] : []),
      pet.name,
      ...(prefs.showSource ? [hasSource(pet) ? pet.source : ""] : []),
      ...(prefs.showRarity ? [pet.rarity ?? ""] : []),
      ...columns.map((v) => {
        if (!pet.variants.includes(v.id)) return NOT_AVAILABLE;
        return caught.includes(v.id) ? CAUGHT_MARK : "";
      }),
    ]);
  }
  return rows;
}

function formatSheet(groups, ctx) {
  const { prefs } = ctx;

  if (prefs.sheetLayout === "perCategory") {
    // A small table for each category, set apart by a blank row: the category as
    // a title, then its own header row and pets. The Category column is
    // redundant here, so it is not added.
    const rows = [];
    for (const group of groups) {
      if (rows.length) rows.push([]);
      if (prefs.showCategory) rows.push([group.label]);
      rows.push(...sheetRows(group.entries, ctx, { category: false }));
    }
    return toDelimited(rows, "\t");
  }

  const entries = groups.flatMap((g) => g.entries);
  return toDelimited(sheetRows(entries, ctx, { category: prefs.showCategory }), "\t");
}

/**
 * @returns {{ text: string, pets: number, variants: number }}  For a sheet, `text`
 *   is tab-separated (what a paste into Sheets or Excel wants); see tsvToCsv.
 */
export function buildExport(ctx) {
  const groups = collect(ctx);
  const entries = groups.flatMap((g) => g.entries);
  return {
    text: ctx.prefs.format === "sheet" ? formatSheet(groups, ctx) : formatText(groups, ctx),
    pets: entries.length,
    variants: entries.reduce((sum, e) => sum + e.variants.length, 0),
  };
}
