/**
 * Export: a list of what's missing (or what's caught), for pasting to whoever
 * you're trading or paying to help index — not the Backup dialog's portable
 * code, which nobody is meant to read.
 *
 * Built here rather than in index.html for the same reason as the other
 * nav dialogs (see settings-modal.js): the DOM is only built when it is first opened.
 *
 * What goes in comes from the filters (categories, sources, rarities, variants and
 * the List option), or from the page itself when "Match page filters" is ticked.
 * What it looks like comes from Format and the Show toggles. The pipeline that does
 * the work is in export-format.js; this file is the dialog around it.
 * The preview is an editable textarea; changing any option regenerates it.
 */

import { showDialog, mountTrigger } from "./modal.js";
import { loadIndex, sourceOptions } from "./data.js";
import { createMenu } from "./ui.js";
import { buildExport, tsvToCsv, SEPARATORS } from "./export-format.js";

const OPEN_PARAM = "export";
const PREFS_KEY = "rcu:v1:export";

const MODES = [
  { id: "missing", label: "Missing pets", noun: "missing", empty: "Nothing missing" },
  { id: "have", label: "Indexed pets", noun: "indexed", empty: "Nothing indexed" },
  { id: "all", label: "All pets", noun: "listed", empty: "Nothing to list" },
];

// A sheet is copied tab-separated (Sheets and Excel split pasted text on tabs, so
// a copied CSV would land in one column) and downloaded as CSV.
const FORMATS = [
  { id: "text", label: "Text", ext: "txt", mime: "text/plain" },
  { id: "sheet", label: "Spreadsheet", ext: "csv", mime: "text/csv" },
];

const LAYOUTS = [
  { id: "single", label: "One table" },
  { id: "perCategory", label: "A table per category" },
];

/** The dropdowns; `key` is both the prefs key and the lookup. */
const FIELDS = [
  { key: "format", label: "Format", options: FORMATS },
  { key: "mode", label: "List", options: MODES },
  { key: "sheetLayout", label: "Spreadsheet layout", options: LAYOUTS },
  { key: "separator", label: "Separator", options: SEPARATORS },
];

/** What the list shows besides the pet's name, each a Show toggle. */
const SHOW = [
  { key: "showCategory", label: "Category" },
  { key: "showSource", label: "Source" },
  { key: "showRarity", label: "Rarity" },
];

/**
 * Variants are stored as what is switched OFF, not what is on, so one added to
 * the data later starts out included instead of silently missing from everyone's
 * saved export. The others are picks, with none picked meaning all.
 */
const DEFAULT_PREFS = {
  format: "text",
  mode: "missing",
  matchPage: false,
  categories: [],
  sources: [],
  rarities: [],
  excludedVariants: [],
  showCategory: true,
  showSource: false,
  showRarity: false,
  sheetLayout: "single",
  separator: "comma",
  abbreviate: false,
};

const LIST_KEYS = ["categories", "sources", "rarities", "excludedVariants"];
const FLAG_KEYS = ["matchPage", "showCategory", "showSource", "showRarity", "abbreviate"];

function loadPrefs() {
  const prefs = { ...DEFAULT_PREFS };
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return prefs;

    // Saved before the sheet and CSV were one format, and before "match the
    // page" was a checkbox rather than a Scope choice.
    if (stored.format === "tsv" || stored.format === "csv") stored.format = "sheet";
    if (stored.scope === "filtered" && stored.matchPage == null) stored.matchPage = true;

    for (const { key, options } of FIELDS) {
      if (options.some((o) => o.id === stored[key])) prefs[key] = stored[key];
    }
    for (const key of FLAG_KEYS) if (typeof stored[key] === "boolean") prefs[key] = stored[key];
    for (const key of LIST_KEYS) {
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

/** A labelled checkbox; `input` is returned so the caller can wire and sync it. */
function checkbox(label, checked, className = "text-sm flex gap-1.5 items-center") {
  const row = el("label", className);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  row.append(input, document.createTextNode(label));
  return { row, input };
}

/** A labelled drop-down (see createMenu); `onChange` gets the new value. */
function buildField(id, label, config) {
  const field = el("div", "flex flex-col gap-1 min-w-0");
  const labelNode = el("span", "field-label", label);
  labelNode.id = `export-${id}-label`;
  const control = createMenu({ id: `export-${id}`, labelledBy: labelNode.id, fill: true, ...config });
  field.append(labelNode, control.element);
  return { field, control };
}

/** A multi-select over the index's categories, sources or rarities. */
function buildMenu(id, label, config) {
  const { field, control } = buildField(id, label, {
    multiple: true,
    ...config,
    onChange: (value) => {
      prefs[id] = value;
      savePrefs();
      render();
    },
  });
  control.setOptions([], []);
  return { field, menu: control };
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

  // The single-choice fields; a pick is saved and the preview rebuilt.
  const fieldFor = (key) => {
    const { label, options } = FIELDS.find((f) => f.key === key);
    const { field, control } = buildField(key, label, {
      onChange: (value) => {
        prefs[key] = value;
        savePrefs();
        render();
      },
    });
    control.setOptions(
      options.map((o) => ({ value: o.id, label: o.label })),
      prefs[key],
    );
    return field;
  };

  const topGrid = el("div", "grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3 mt-4");
  topGrid.append(fieldFor("format"), fieldFor("mode"));

  // What goes in: the page's own view, or picks made here.
  const matchPage = checkbox("", prefs.matchPage, "text-sm flex gap-2 items-center mt-3");
  const matchPageText = matchPage.row.lastChild;

  const menus = {
    categories: buildMenu("categories", "Categories", {
      allLabel: "All categories",
      countLabel: (n) => `${n} categories`,
    }),
    sources: buildMenu("sources", "Sources", {
      allLabel: "All sources",
      countLabel: (n) => `${n} sources`,
      searchLabel: "Search sources or categories",
    }),
    rarities: buildMenu("rarities", "Rarities", {
      allLabel: "All rarities",
      countLabel: (n) => `${n} rarities`,
    }),
  };
  const pickGrid = el("div", "grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-3 mt-3");
  pickGrid.append(...Object.values(menus).map((m) => m.field));

  // Filled in once the index is loaded; the variants are data.
  const variantBox = el("div", "flex flex-wrap items-center gap-x-4 gap-y-1 mt-3");
  const filtersReset = el("button", "linkish text-[13px] ml-auto", "Reset filters");
  filtersReset.type = "button";

  // What it looks like.
  const showBox = el("div", "flex flex-wrap items-center gap-x-4 gap-y-1 mt-3");
  showBox.append(el("span", "text-muted text-[13px]", "Show"));
  const shows = new Map();
  for (const { key, label } of SHOW) {
    const box = checkbox(label, prefs[key]);
    shows.set(key, box.input);
    showBox.append(box.row);
  }

  const more = el("details", "mt-3");
  more.append(el("summary", "text-sm cursor-pointer", "More options"));
  const moreBody = el("div", "grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3 mt-2");
  const layoutField = fieldFor("sheetLayout");
  const separatorField = fieldFor("separator");
  const abbr = checkbox("Use abbreviations (N, G, T, Gal)", prefs.abbreviate, "text-sm flex gap-2 items-center sm:col-span-2");
  moreBody.append(layoutField, separatorField, abbr.row);
  more.append(moreBody);

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

  variantBox.append(el("span", "text-muted text-[13px]", "Variants"));
  variantBox.append(filtersReset);

  dialog.append(
    closeForm,
    heading,
    intro,
    topGrid,
    matchPage.row,
    pickGrid,
    variantBox,
    showBox,
    more,
    meta,
    textarea,
    editNote,
    actions,
    buildToast(),
  );
  document.body.append(dialog);

  return {
    dialog,
    matchPage: matchPage.input,
    matchPageRow: matchPage.row,
    matchPageText,
    menus,
    pickGrid,
    variantBox,
    filtersReset,
    shows,
    layoutField,
    separatorField,
    abbrRow: abbr.row,
    abbrInput: abbr.input,
    meta,
    textarea,
    editNote,
    revert,
    copyButton,
    downloadButton,
    toast: dialog.lastElementChild,
  };
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

const isSheet = () => prefs.format === "sheet";

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

/** Which controls apply: the page-match checkbox hides the picks, the format hides what it ignores. */
function syncFieldStates() {
  const sheet = isSheet();
  ui.pickGrid.hidden = prefs.matchPage;
  ui.layoutField.hidden = !sheet;
  for (const node of [ui.separatorField, ui.abbrRow]) node.hidden = sheet;
  // A row per line: wrapping would make one pet look like several.
  ui.textarea.wrap = sheet ? "off" : "soft";

  // "The page" is whatever tab the table is on, which is the whole index when that
  // tab is All. The tooltip names it so the checkbox does not look like it does nothing.
  const tab = host.getActiveCategory?.()?.label;
  ui.matchPageText.textContent = "Match page filters";
  ui.matchPageRow.title = tab ? `The ${tab} tab, with the filters set on the page` : "";
}

/** The pets the page is showing now, or null when the picks here are in charge. */
function pagePets() {
  if (!prefs.matchPage) return null;
  const category = host.getActiveCategory?.();
  if (!category) return [];
  return host.filterPets?.(category) ?? category.pets;
}

function render() {
  syncFieldStates();
  if (!index) return setPreview("", "Loading pet list…");

  if (!host.getProfileId?.()) return setPreview("", "Create a profile first.");

  const mode = MODES.find((m) => m.id === prefs.mode);
  const { text, pets, variants } = buildExport({
    index,
    prefs,
    progress: host.getProgress?.() ?? {},
    pagePets: pagePets(),
  });

  if (!pets) return setPreview("", `${mode.empty} with these settings.`);

  setPreview(
    text,
    `${pets.toLocaleString()} pet${pets === 1 ? "" : "s"} · ${variants.toLocaleString()} variant${variants === 1 ? "" : "s"} ${mode.noun}`,
  );
}

/** Keep only picks that still exist, so a saved pick the data no longer has cannot silently empty the export. */
const stillExist = (picks, options) => picks.filter((p) => options.some((o) => o.value === p));

/** The menus' options and the variant checkboxes; both need the index. */
function renderFilters() {
  if (!index) return;

  const categories = index.categories
    .filter((c) => !c.virtual && c.pets.length)
    .map((c) => ({ value: c.id, label: c.label }));
  const everything = index.categories.find((c) => c.virtual) ?? index.categories[0];
  const sources = sourceOptions(index, everything);
  const rarities = [...rarityRank()].sort((a, b) => a[1] - b[1]).map(([name]) => ({ value: name, label: name }));
  if ([...index.bySlug.values()].some((p) => !p.rarity)) rarities.push({ value: "", label: "No rarity listed" });

  const options = { categories, sources, rarities };
  for (const [key, list] of Object.entries(options)) {
    prefs[key] = stillExist(prefs[key], list);
    ui.menus[key].menu.setOptions(list, prefs[key]);
  }

  if (filtersBuilt) return;
  filtersBuilt = true;

  for (const v of index.variants) {
    const box = checkbox(v.label, !prefs.excludedVariants.includes(v.id));
    box.input.dataset.id = v.id;
    box.input.addEventListener("change", () => {
      prefs.excludedVariants = box.input.checked
        ? prefs.excludedVariants.filter((x) => x !== v.id)
        : [...prefs.excludedVariants, v.id];
      savePrefs();
      render();
    });
    ui.variantBox.insertBefore(box.row, ui.filtersReset);
  }
}

function resetFilters() {
  Object.assign(prefs, { matchPage: false, categories: [], sources: [], rarities: [], excludedVariants: [] });
  savePrefs();
  ui.matchPage.checked = false;
  for (const input of ui.variantBox.querySelectorAll("input[type=checkbox]")) input.checked = true;
  renderFilters();
  render();
}

function download() {
  const format = FORMATS.find((f) => f.id === prefs.format);
  // The preview holds the tab-separated sheet; a file wants commas. Excel reads a
  // CSV as the system code page unless it starts with a BOM, which turns any
  // accented pet name into mojibake.
  const body = isSheet() ? "﻿" + tsvToCsv(ui.textarea.value) : ui.textarea.value;
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
  const flag = (input, key) =>
    input.addEventListener("change", () => {
      prefs[key] = input.checked;
      savePrefs();
      render();
    });
  flag(ui.matchPage, "matchPage");
  flag(ui.abbrInput, "abbreviate");
  for (const [key, input] of ui.shows) flag(input, key);

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
 *   filter predicate, so "Match page filters" can never drift from the table.
 */
export function mountExportModal(options = {}) {
  if (!mountTrigger("data-open-export", OPEN_PARAM, openExport)) return;
  host = options;
}
