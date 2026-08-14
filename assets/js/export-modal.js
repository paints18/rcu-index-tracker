/**
 * Export: a plain-text list of what's still missing, for pasting to whoever
 * you're trading or paying to help index — not the Backup dialog's portable
 * code, which nobody is meant to read.
 *
 * Built here rather than in index.html for the same reason as the other
 * nav dialogs (see settings-modal.js): lazy DOM, and one copy shared by the
 * tracker and the editor.
 */

import { showDialog, mountTrigger } from "./modal.js";
import { loadIndex } from "./data.js";

const OPEN_PARAM = "export";

const SCOPES = [
  { id: "all", label: "Whole index" },
  { id: "category", label: "Current world" },
  { id: "filtered", label: "Match current filters" },
];

const SEPARATORS = [
  { id: "comma", label: "Comma (Golden, Toxic)", join: ", " },
  { id: "slash", label: "Slash (Golden/Toxic)", join: "/" },
];

/**
 * Only 4 variants exist in the whole dataset, so a hand-picked map reads
 * better than deriving codes from the label (e.g. Golden and Galaxy both
 * start with G).
 */
const ABBREVIATIONS = { normal: "N", golden: "G", toxic: "T", galaxy: "Gal" };

/** Options from mountExportModal(). */
let host = {};

let index = null;
let indexPromise = null;

/** Built on first open. */
let ui = null;
let scope = "all";
let abbreviate = false;
let separator = "comma";

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
  dialog.setAttribute("aria-label", "Export missing list");

  const closeForm = document.createElement("form");
  closeForm.method = "dialog";
  closeForm.className = "float-right -mt-2 -mr-1.5";
  const close = el("button", "dialog-x", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close export missing list");
  close.addEventListener("click", () => dialog.close());
  closeForm.append(close);

  const heading = el("h2", null, "Export missing pet list");
  const intro = el("p", "text-muted text-[13px]", "Copy what you still need to index.");

  const scopeFieldset = el("fieldset", "border-0 p-0 m-0 flex flex-col gap-1.5 mt-4");
  const legend = el("legend", "field-label", "Scope");
  scopeFieldset.append(legend);

  const scopeInputs = new Map();
  for (const option of SCOPES) {
    const label = el("label", "text-sm flex gap-2 items-center");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "export-scope";
    input.value = option.id;
    if (option.id === scope) input.checked = true;
    label.append(input, document.createTextNode(option.label));
    scopeFieldset.append(label);
    scopeInputs.set(option.id, input);
  }

  const formatFieldset = el("fieldset", "border-0 p-0 m-0 flex flex-col gap-1.5 mt-4");
  formatFieldset.append(el("legend", "field-label", "Format"));

  const abbrLabel = el("label", "text-sm flex gap-2 items-center");
  const abbrInput = document.createElement("input");
  abbrInput.type = "checkbox";
  abbrInput.checked = abbreviate;
  abbrLabel.append(abbrInput, document.createTextNode("Use abbreviations (N, G, T, Gal)"));
  formatFieldset.append(abbrLabel);

  const sepGroup = el("div", "flex flex-col gap-1.5 mt-1");
  sepGroup.append(el("span", "text-muted text-[13px]", "Separator"));
  const sepInputs = new Map();
  for (const option of SEPARATORS) {
    const label = el("label", "text-sm flex gap-2 items-center");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "export-separator";
    input.value = option.id;
    if (option.id === separator) input.checked = true;
    label.append(input, document.createTextNode(option.label));
    sepGroup.append(label);
    sepInputs.set(option.id, input);
  }
  formatFieldset.append(sepGroup);

  const meta = el("p", "text-muted text-[13px] mt-3");
  const textarea = document.createElement("textarea");
  textarea.readOnly = true;
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.className = "mt-2";
  textarea.setAttribute("aria-label", "Missing pets and variants");

  const copyButton = el("button", "btn btn-primary self-start mt-3", "Copy to clipboard");
  copyButton.type = "button";

  dialog.append(
    closeForm,
    heading,
    intro,
    scopeFieldset,
    formatFieldset,
    meta,
    textarea,
    copyButton,
    buildToast(),
  );
  document.body.append(dialog);

  return {
    dialog,
    scopeInputs,
    abbrInput,
    sepInputs,
    meta,
    textarea,
    copyButton,
    toast: dialog.lastElementChild,
  };
}

/** Variant id -> display label, from the loaded index. */
function labelMap() {
  return new Map(index.variants.map((v) => [v.id, v.label]));
}

/** Missing-variant lines for one category's pets, in display order, no header. */
function linesFor(pets, labels) {
  const progress = host.getProgress?.() ?? {};
  const join = SEPARATORS.find((s) => s.id === separator)?.join ?? ", ";
  const lines = [];
  let missingCount = 0;

  for (const pet of pets) {
    const caught = progress[pet.slug] ?? [];
    const missing = pet.variants.filter((v) => !caught.includes(v));
    if (!missing.length) continue;

    missingCount += missing.length;
    const names = missing.map((v) => (abbreviate ? ABBREVIATIONS[v] : null) ?? labels.get(v) ?? v);
    lines.push(`${pet.name} - ${names.join(join)}`);
  }

  return { lines, missingCount };
}

/** @returns {{text: string, pets: number, variants: number}} */
function buildExport() {
  const labels = labelMap();
  // The "All" category holds the same pets as every other category, reused
  // rather than copied — walking it here alongside the rest would export
  // everything twice.
  const categories = index.categories.filter((c) => !c.virtual);

  let scoped;
  if (scope === "category") {
    const category = host.getActiveCategory?.();
    scoped = category ? [{ category, pets: category.pets }] : [];
  } else if (scope === "filtered") {
    const category = host.getActiveCategory?.();
    scoped = category
      ? [{ category, pets: host.filterPets?.(category) ?? category.pets }]
      : [];
  } else {
    scoped = categories.map((category) => ({ category, pets: category.pets }));
  }

  const multiCategory = scoped.length > 1;
  const blocks = [];
  let pets = 0;
  let variants = 0;

  for (const { category, pets: catPets } of scoped) {
    const { lines, missingCount } = linesFor(catPets, labels);
    if (!lines.length) continue;

    pets += lines.length;
    variants += missingCount;

    blocks.push(multiCategory ? [category.label, ...lines].join("\n") : lines.join("\n"));
  }

  return { text: blocks.join("\n\n"), pets, variants };
}

function render() {
  if (!index) {
    ui.meta.textContent = "Loading pet list…";
    ui.textarea.value = "";
    ui.copyButton.disabled = true;
    return;
  }

  if (!host.getProfileId?.()) {
    ui.meta.textContent = "Create a profile first.";
    ui.textarea.value = "";
    ui.copyButton.disabled = true;
    return;
  }

  const { text, pets, variants } = buildExport();

  if (!pets) {
    ui.meta.textContent = "Nothing missing in this scope.";
    ui.textarea.value = "";
    ui.copyButton.disabled = true;
    return;
  }

  ui.meta.textContent = `${pets.toLocaleString()} pet${pets === 1 ? "" : "s"} · ${variants.toLocaleString()} variant${variants === 1 ? "" : "s"} missing`;
  ui.textarea.value = text;
  ui.copyButton.disabled = false;
}

function wire() {
  for (const [id, input] of ui.scopeInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      scope = id;
      render();
    });
  }

  ui.abbrInput.addEventListener("change", () => {
    abbreviate = ui.abbrInput.checked;
    render();
  });

  for (const [id, input] of ui.sepInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      separator = id;
      render();
    });
  }

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

  render();
  showDialog(ui.dialog);

  await ensureIndex();
  if (!ui.dialog.open) return;
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
