/**
 * Export: a list of what's missing (or what's caught), for pasting to whoever
 * you're trading or paying to help index — not the Backup dialog's portable
 * code, which nobody is meant to read.
 *
 * Built here rather than in index.html for the same reason as the other
 * nav dialogs (see settings-modal.js): the DOM is only built when it is first opened.
 *
 * The list is built in stages: scope picks the pets, filters trim them, group-by
 * shapes them into lines, and a formatter turns those into text, a sheet (tab-separated,
 * for pasting into Sheets or Excel) or a CSV file.
 * The preview is an editable textarea; changing any option regenerates it.
 */

import { showDialog, mountTrigger } from "./modal.js";
import { loadIndex } from "./data.js";

const OPEN_PARAM = "export";
const PREFS_KEY = "rcu:v1:export";

const MODES = [
  { id: "missing", label: "Missing pets", noun: "missing", empty: "Nothing missing" },
  { id: "have", label: "Pets I have", noun: "caught", empty: "Nothing caught" },
  { id: "all", label: "All pets", noun: "listed", empty: "Nothing to list" },
];

const SCOPES = [
  { id: "all", label: "Whole index" },
  { id: "category", label: "Current tab" },
  { id: "filtered", label: "Match current filters" },
];

const SEPARATORS = [
  { id: "comma", label: "Comma (Golden, Toxic)", join: ", " },
  { id: "slash", label: "Slash (Golden/Toxic)", join: "/" },
];

const GROUPS = [
  { id: "pet", label: "Pet (one line per pet)" },
  { id: "variant", label: "Variant (one line per variant)" },
];

/**
 * What a spreadsheet cell holds. A caught variant gets a tick; a missing one is
 * left blank, so the sheet reads as a filled-in checklist; and a variant the pet
 * does not have gets a dash, so "no such variant" is not mistaken for "not caught
 * yet".
 */
const CAUGHT_MARK = "✓";
const NOT_AVAILABLE = "-";

const FORMATS = [
  { id: "text", label: "Plain text", ext: "txt", mime: "text/plain" },
  // Sheets and Excel split pasted text on tabs, not commas, so a copied CSV lands in
  // one column. Copying wants the tab-separated format; a downloaded file wants CSV.
  { id: "tsv", label: "Spreadsheet (paste into Sheets or Excel)", ext: "tsv", mime: "text/tab-separated-values" },
  { id: "csv", label: "CSV file", ext: "csv", mime: "text/csv" },
];

/**
 * The dropdowns, in dialog order. `key` is both the prefs key and the lookup.
 * Format comes first because it decides which of the others apply.
 */
const FIELDS = [
  { key: "format", label: "Format", options: FORMATS },
  { key: "mode", label: "List", options: MODES },
  { key: "scope", label: "Scope", options: SCOPES },
  { key: "groupBy", label: "Group by", options: GROUPS },
  { key: "separator", label: "Separator", options: SEPARATORS },
];

/**
 * Only 4 variants exist in the whole dataset, so a hand-picked map reads
 * better than deriving codes from the label (e.g. Golden and Galaxy both
 * start with G).
 */
const ABBREVIATIONS = { normal: "N", golden: "G", toxic: "T", galaxy: "Gal" };

/**
 * Filters are stored as what is switched OFF, not what is on, so a variant or
 * rarity added to the data later starts out included instead of silently
 * missing from everyone's saved export.
 */
const DEFAULT_PREFS = {
  mode: "missing",
  scope: "all",
  groupBy: "pet",
  format: "text",
  separator: "comma",
  abbreviate: false,
  excludedVariants: [],
  excludedRarities: [],
};

function loadPrefs() {
  const prefs = { ...DEFAULT_PREFS };
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return prefs;

    for (const { key, options } of FIELDS) {
      if (options.some((o) => o.id === stored[key])) prefs[key] = stored[key];
    }
    if (typeof stored.abbreviate === "boolean") prefs.abbreviate = stored.abbreviate;
    for (const key of ["excludedVariants", "excludedRarities"]) {
      if (Array.isArray(stored[key])) prefs[key] = stored[key].filter((v) => typeof v === "string");
    }
  } catch {
    // Unreadable or disabled storage: fall back to the defaults.
  }
  return prefs;
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage disabled — options simply will not persist.
  }
}

/** Options from mountExportModal(). */
let host = {};

let index = null;
let indexPromise = null;

/** Built on first open. */
let ui = null;
let filtersBuilt = false;
let edited = false;
const prefs = loadPrefs();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Own toast: a modal <dialog> is in the top layer, the page's toast is not. */
function buildToast() {
  const node = el(
    "div",
    "fixed left-1/2 bottom-6 -translate-x-1/2 bg-raised border border-edge-hi " +
      "rounded-full px-[18px] py-2.5 text-sm toast-shadow z-50",
  );
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  return node;
}

let toastTimer = null;
function toast(message) {
  const node = ui.toast;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

function buildDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.setAttribute("aria-label", "Export pets");

  const closeForm = document.createElement("form");
  closeForm.method = "dialog";
  closeForm.className = "float-right -mt-2 -mr-1.5";
  const close = el("button", "dialog-x", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close export pets");
  close.addEventListener("click", () => dialog.close());
  closeForm.append(close);

  const heading = el("h2", null, "Export pets");
  const intro = el("p", "text-muted text-[13px]", "Build a list to copy, download or edit.");

  const grid = el("div", "grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3 mt-4");
  const selects = new Map();
  for (const { key, label, options } of FIELDS) {
    const wrap = el("label", "flex flex-col gap-1");
    wrap.append(el("span", "field-label", label));
    const select = document.createElement("select");
    select.className = "w-full";
    for (const option of options) {
      const node = el("option", null, option.label);
      node.value = option.id;
      select.append(node);
    }
    select.value = prefs[key];
    wrap.append(select);
    grid.append(wrap);
    selects.set(key, select);
  }

  const abbrLabel = el("label", "text-sm flex gap-2 items-center mt-3");
  const abbrInput = document.createElement("input");
  abbrInput.type = "checkbox";
  abbrInput.checked = prefs.abbreviate;
  abbrLabel.append(abbrInput, document.createTextNode("Use abbreviations (N, G, T, Gal)"));

  // Filled in once the index is loaded; the variants and rarities are data.
  const filters = el("details", "mt-3");
  const filtersSummary = el("summary", "text-sm cursor-pointer", "Filters");
  const filtersBody = el("div", "flex flex-col gap-2.5 mt-2");
  const variantBox = el("div", "flex flex-wrap gap-x-4 gap-y-1");
  const rarityBox = el("div", "flex flex-wrap gap-x-4 gap-y-1");
  const filtersReset = el("button", "btn btn-quiet btn-sm self-start", "Reset filters");
  filtersReset.type = "button";
  filtersBody.append(
    el("span", "text-muted text-[13px]", "Variants"),
    variantBox,
    el("span", "text-muted text-[13px]", "Rarity"),
    rarityBox,
    filtersReset,
  );
  filters.append(filtersSummary, filtersBody);

  const meta = el("p", "text-muted text-[13px] mt-3");
  const textarea = document.createElement("textarea");
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.className = "mt-2";
  textarea.setAttribute("aria-label", "Export preview (editable)");

  const editNote = el("p", "text-[13px] mt-1.5");
  editNote.hidden = true;
  const revert = el("button", "linkish", "Revert edits");
  revert.type = "button";
  editNote.append(revert);

  const actions = el("div", "flex gap-2 mt-3");
  const copyButton = el("button", "btn btn-primary", "Copy to clipboard");
  copyButton.type = "button";
  const downloadButton = el("button", "btn", "Download");
  downloadButton.type = "button";
  actions.append(copyButton, downloadButton);

  dialog.append(
    closeForm,
    heading,
    intro,
    grid,
    abbrLabel,
    filters,
    meta,
    textarea,
    editNote,
    actions,
    buildToast(),
  );
  document.body.append(dialog);

  return {
    dialog,
    selects,
    abbrLabel,
    abbrInput,
    filtersSummary,
    variantBox,
    rarityBox,
    filtersReset,
    meta,
    textarea,
    editNote,
    revert,
    copyButton,
    downloadButton,
    toast: dialog.lastElementChild,
  };
}

/** Variant id -> display label, from the loaded index. */
function labelMap() {
  return new Map(index.variants.map((v) => [v.id, v.label]));
}

/**
 * Rarity name -> its first-seen position across the whole index.
 *
 * Not a hand-written tier list: the categories already read low tier to high
 * within each world (see data/pets.json), so walking pets in file order and
 * recording each rarity the first time it appears reconstructs that same
 * ladder without anyone having to keep a second copy of it in sync.
 */
function rarityRank() {
  const rank = new Map();
  for (const pet of index.bySlug.values()) {
    if (pet.rarity && !rank.has(pet.rarity)) rank.set(pet.rarity, rank.size);
  }
  return rank;
}

/**
 * `[{ label, pets }]` for the chosen scope, before any filtering. Pets stay in
 * the table's own order: grouped by world and, within a world, ascending by
 * Clicks, which is how the source data is entered.
 */
function scopedGroups() {
  if (prefs.scope === "category" || prefs.scope === "filtered") {
    const category = host.getActiveCategory?.();
    if (!category) return [];
    const pets =
      prefs.scope === "filtered" ? (host.filterPets?.(category) ?? category.pets) : category.pets;
    return [{ label: category.label, pets }];
  }

  // The "All" category holds the same pets as every other category, reused
  // rather than copied — walking it here alongside the rest would export
  // everything twice.
  return index.categories.filter((c) => !c.virtual).map((c) => ({ label: c.label, pets: c.pets }));
}

/**
 * Apply the mode and filters: `[{ label, entries: [{ pet, variants }] }]`, where
 * `variants` are the ids that made the cut. Pets with none left, and groups with
 * no pets left, are dropped.
 */
function collect() {
  const progress = host.getProgress?.() ?? {};
  const wantCaught = prefs.mode === "have";
  const skipVariants = new Set(prefs.excludedVariants);
  const skipRarities = new Set(prefs.excludedRarities);
  const groups = [];

  for (const { label, pets } of scopedGroups()) {
    const entries = [];
    for (const pet of pets) {
      if (skipRarities.has(pet.rarity ?? "")) continue;
      const caught = progress[pet.slug] ?? [];
      const variants = pet.variants.filter(
        (v) => !skipVariants.has(v) && (prefs.mode === "all" || caught.includes(v) === wantCaught),
      );
      if (variants.length) entries.push({ pet, variants });
    }
    if (entries.length) groups.push({ label, entries });
  }
  return groups;
}

/** Regroup a group's entries as `[{ variant, pets }]`, in the data's variant order. */
function byVariant(entries) {
  const grouped = new Map(index.variants.map((v) => [v.id, []]));
  for (const { pet, variants } of entries) {
    for (const id of variants) {
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(pet);
    }
  }
  return [...grouped].filter(([, pets]) => pets.length).map(([variant, pets]) => ({ variant, pets }));
}

function variantName(id, labels) {
  return (prefs.abbreviate ? ABBREVIATIONS[id] : null) ?? labels.get(id) ?? id;
}

/** A cell, quoted when it holds the delimiter, a quote or a line break. */
function sheetCell(value, delimiter) {
  const text = value == null ? "" : String(value);
  const special = text.includes(delimiter) || /["\r\n]/.test(text);
  return special ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The sheet format and CSV are the same matrix; only the delimiter differs. */
const isMatrix = () => prefs.format === "csv" || prefs.format === "tsv";

/**
 * One line per pet or per variant, as `{ head, parts }`: "Dog - Golden, Toxic"
 * grouped by pet, "Golden - Dog, Cat" grouped by variant.
 */
function linesOf(entries, labels) {
  if (prefs.groupBy === "variant") {
    return byVariant(entries).map(({ variant, pets }) => ({
      head: variantName(variant, labels),
      parts: pets.map((p) => p.name),
    }));
  }
  return entries.map(({ pet, variants }) => ({
    head: pet.name,
    parts: variants.map((v) => variantName(v, labels)),
  }));
}

function formatList(groups, labels) {
  const join = SEPARATORS.find((s) => s.id === prefs.separator)?.join ?? ", ";

  if (isMatrix()) {
    // One row per pet and one column per variant, like the list view; a caught
    // variant gets the mark and a missing one stays blank. The List option picks the
    // rows. Group by, Separator and abbreviations do not apply. Columns nobody in
    // the export has (say Galaxy, in a world with no Galaxy pets) are left out.
    const progress = host.getProgress?.() ?? {};
    const worldOf = new Map(index.categories.map((c) => [c.id, c.label]));
    const skip = new Set(prefs.excludedVariants);
    const entries = groups.flatMap((g) => g.entries);
    const columns = index.variants.filter(
      (v) => !skip.has(v.id) && entries.some(({ pet }) => pet.variants.includes(v.id)),
    );

    const rows = [["World", "Pet", ...columns.map((v) => labels.get(v.id) ?? v.id)]];
    for (const { pet } of entries) {
      const caught = progress[pet.slug] ?? [];
      rows.push([
        worldOf.get(pet.categoryId),
        pet.name,
        ...columns.map((v) => {
          if (!pet.variants.includes(v.id)) return NOT_AVAILABLE;
          return caught.includes(v.id) ? CAUGHT_MARK : "";
        }),
      ]);
    }
    const delimiter = prefs.format === "tsv" ? "\t" : ",";
    return rows.map((row) => row.map((c) => sheetCell(c, delimiter)).join(delimiter)).join("\n");
  }

  // A header would just repeat what the Scope dropdown already said when there
  // is only one group.
  const headed = groups.length > 1;

  return groups
    .map(({ label, entries }) => {
      const lines = linesOf(entries, labels).map(({ head, parts }) => `${head} - ${parts.join(join)}`);
      return (headed ? [label, ...lines] : lines).join("\n");
    })
    .join("\n\n");
}

/** @returns {{text: string, pets: number, variants: number}} */
function buildExport() {
  const groups = collect();
  const entries = groups.flatMap((g) => g.entries);
  return {
    text: formatList(groups, labelMap()),
    pets: entries.length,
    variants: entries.reduce((sum, e) => sum + e.variants.length, 0),
  };
}

function setEdited(value) {
  edited = value;
  ui.editNote.hidden = !value;
}

function setPreview(text, meta) {
  ui.meta.textContent = meta;
  ui.textarea.value = text;
  ui.copyButton.disabled = !text;
  ui.downloadButton.disabled = !text;
  setEdited(false);
}

/**
 * Group by, Separator and abbreviations shape the text list; a sheet or CSV is
 * always pets by variant columns, so they are hidden there.
 */
function syncFieldStates() {
  const csv = isMatrix();
  for (const key of ["groupBy", "separator"]) ui.selects.get(key).parentElement.hidden = csv;
  ui.abbrLabel.hidden = csv;
  // A row per line: wrapping would make one pet look like several.
  ui.textarea.wrap = csv ? "off" : "soft";

  // "Current world" is whatever tab the table is on, which is the whole index when
  // that tab is All. Naming it here keeps that from looking like Scope is ignored.
  const tab = host.getActiveCategory?.()?.label;
  const current = ui.selects.get("scope").querySelector('option[value="category"]');
  current.textContent = tab ? `Current tab (${tab})` : "Current tab";
}

function render() {
  syncFieldStates();
  if (!index) return setPreview("", "Loading pet list…");

  if (!host.getProfileId?.()) return setPreview("", "Create a profile first.");

  const mode = MODES.find((m) => m.id === prefs.mode);
  const { text, pets, variants } = buildExport();

  if (!pets) {
    const filtered = prefs.excludedVariants.length || prefs.excludedRarities.length;
    return setPreview("", `${mode.empty} in this scope${filtered ? " with these filters" : ""}.`);
  }

  setPreview(
    text,
    `${pets.toLocaleString()} pet${pets === 1 ? "" : "s"} · ${variants.toLocaleString()} variant${variants === 1 ? "" : "s"} ${mode.noun}`,
  );
}

/** The checkbox rows and the summary count; the checkboxes need the index. */
function renderFilters() {
  const off = prefs.excludedVariants.length + prefs.excludedRarities.length;
  ui.filtersSummary.textContent = off ? `Filters (${off} off)` : "Filters";

  if (!index || filtersBuilt) return;
  filtersBuilt = true;

  const addCheck = (box, listKey, id, label) => {
    const row = el("label", "text-sm flex gap-1.5 items-center");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !prefs[listKey].includes(id);
    input.dataset.id = id;
    input.addEventListener("change", () => {
      prefs[listKey] = input.checked
        ? prefs[listKey].filter((x) => x !== id)
        : [...prefs[listKey], id];
      savePrefs();
      renderFilters();
      render();
    });
    row.append(input, document.createTextNode(label));
    box.append(row);
  };

  for (const v of index.variants) addCheck(ui.variantBox, "excludedVariants", v.id, v.label);

  const rarities = [...rarityRank()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  if ([...index.bySlug.values()].some((p) => !p.rarity)) rarities.push("");
  for (const r of rarities) addCheck(ui.rarityBox, "excludedRarities", r, r || "No rarity listed");
}

function resetFilters() {
  prefs.excludedVariants = [];
  prefs.excludedRarities = [];
  savePrefs();
  for (const input of ui.dialog.querySelectorAll("details input[type=checkbox]")) input.checked = true;
  renderFilters();
  render();
}

function download() {
  const format = FORMATS.find((f) => f.id === prefs.format);
  // Excel reads a CSV as the system code page unless it starts with a BOM, which
  // turns any accented pet name into mojibake.
  const body = (isMatrix() ? "\uFEFF" : "") + ui.textarea.value;
  const url = URL.createObjectURL(new Blob([body], { type: `${format.mime};charset=utf-8` }));
  const link = el("a");
  link.href = url;
  link.download = `rcu-${prefs.mode}-pets.${format.ext}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wire() {
  for (const [key, select] of ui.selects) {
    select.addEventListener("change", () => {
      prefs[key] = select.value;
      savePrefs();
      render();
    });
  }

  ui.abbrInput.addEventListener("change", () => {
    prefs.abbreviate = ui.abbrInput.checked;
    savePrefs();
    render();
  });

  ui.filtersReset.addEventListener("click", resetFilters);

  ui.textarea.addEventListener("input", () => {
    setEdited(true);
    ui.copyButton.disabled = !ui.textarea.value;
    ui.downloadButton.disabled = !ui.textarea.value;
  });
  ui.revert.addEventListener("click", render);

  ui.downloadButton.addEventListener("click", download);

  ui.copyButton.addEventListener("click", async () => {
    if (!ui.textarea.value) return;
    try {
      await navigator.clipboard.writeText(ui.textarea.value);
      toast("List copied.");
    } catch {
      // Clipboard API needs a secure context; selecting the text is the fallback.
      ui.textarea.select();
      toast("Press Ctrl+C to copy.");
    }
  });
}

async function ensureIndex() {
  const supplied = host.getIndex?.();
  if (supplied) {
    index = supplied;
    return;
  }
  indexPromise ??= loadIndex().catch(() => null);
  index = await indexPromise;
}

export async function openExport() {
  if (!ui) {
    ui = buildDialog();
    wire();
  }

  renderFilters();
  render();
  showDialog(ui.dialog);

  await ensureIndex();
  if (!ui.dialog.open) return;
  renderFilters();
  render();
}

/**
 * @param {object}   [options]
 * @param {Function} [options.getIndex] Returns an already-loaded pet index, or a
 *   falsy value to have the dialog fetch its own.
 * @param {Function} [options.getProfileId] Returns the active profile id, or a
 *   falsy value if no profile exists yet.
 * @param {Function} [options.getProgress] Returns the active profile's progress.
 * @param {Function} [options.getActiveCategory] Returns the category currently
 *   showing on the table.
 * @param {Function} [options.filterPets] `(category) => pets[]`, the table's own
 *   filter predicate, so "match current filters" can never drift from the table.
 */
export function mountExportModal(options = {}) {
  if (!mountTrigger("data-open-export", OPEN_PARAM, openExport)) return;
  host = options;
}
