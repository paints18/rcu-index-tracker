/**
 * Settings, in a dialog.
 *
 * Settings used to be a page of their own. As a modal they open over whatever
 * you were looking at, so a theme or density change is judged against
 * the actual table instead of an empty preferences page — and closing it puts
 * you back exactly where you were.
 *
 * The markup is built here rather than written in HTML: this dialog is offered
 * from the tracker and from the editor, and two hand-kept copies of the same
 * form would drift. Building it also means it is lazy — a visitor who never
 * opens Settings never pays for the DOM.
 *
 * Pages opt in by calling mountSettingsModal() and marking a trigger with
 * `data-open-settings`.
 */

import {
  MODES,
  THEMES,
  DENSITIES,
  COLUMNS,
  loadSettings,
  saveSettings,
  resetSettings,
  applySettings,
} from "./settings-store.js";
import { Store, PROBE_KEY } from "./store.js";
import { loadIndex, countProgress } from "./data.js";
import { createDialog, showDialog, mountTrigger } from "./modal.js";

/** Old settings.html bookmarks land on the tracker with ?settings — see settings.html. */
const OPEN_PARAM = "settings";

const store = new Store(null);

let settings = loadSettings();
let index = null;
let indexPromise = null;

/** Built on first open. */
let ui = null;
/** Options from mountSettingsModal(), shared by every trigger on the page. */
let host = {};

/* ------------------------------------------------------------------ */
/* dom helpers                                                         */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function group(title) {
  const section = el("section", "settings-group");
  section.append(el("h3", "section-title mb-1", title));
  return section;
}

/**
 * @param {string} [labelClass]
 * @param {boolean} [stacked] Put the control under the label, full width, rather
 *   than opposite it — for controls too wide for the right-hand column.
 */
function row(label, hint, control, labelClass = "", stacked = false) {
  const wrap = el("div", `setting-row${stacked ? " setting-row-stacked" : ""}`);
  const left = el("div");
  left.append(el("div", `setting-label${labelClass ? ` ${labelClass}` : ""}`, label));
  if (hint) left.append(el("p", "setting-hint", hint));
  wrap.append(left, control);
  return wrap;
}

function checkbox(text) {
  const label = el("label", "flex items-center gap-2 text-sm");
  const input = document.createElement("input");
  input.type = "checkbox";
  label.append(input, el("span", null, text));
  return { label, input };
}

function button(className, text) {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

/**
 * Our own toast, living inside the dialog rather than reusing the page's.
 *
 * A modal <dialog> is in the top layer, so a toast parked on <body> — including
 * the tracker's own — would come out behind the backdrop, dimmed. Being a child
 * of the dialog puts it in the same layer. `position: fixed` still measures from
 * the viewport, so it lands bottom-centre on screen, not inside the box.
 */
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

/* ------------------------------------------------------------------ */
/* confirm dialog                                                      */
/* ------------------------------------------------------------------ */

/**
 * A second <dialog> stacked over the settings one. Nested modals share the top
 * layer, so the confirm sits above settings and Esc closes only the confirm.
 */
function buildConfirm() {
  const dialog = el("dialog", "dialog max-w-[460px]");
  const title = el("h2", null, "Are you sure?");
  const body = el("p", "text-muted text-[13px] mt-1.5");

  const actions = el("div", "flex gap-2 justify-end mt-5");
  const cancel = button("btn btn-quiet", "Cancel");
  const ok = button("btn btn-danger-solid", "Confirm");
  actions.append(cancel, ok);

  dialog.append(title, body, actions);
  cancel.addEventListener("click", () => dialog.close());
  document.body.append(dialog);

  return { dialog, title, body, cancel, ok };
}

function confirmAction(titleText, bodyText, okLabel = "Confirm") {
  const { dialog, title, body, cancel, ok } = ui.confirm;

  title.textContent = titleText;
  body.textContent = bodyText;
  ok.textContent = okLabel;

  return new Promise((resolve) => {
    const onOk = () => {
      cleanup();
      dialog.close();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    function cleanup() {
      ok.removeEventListener("click", onOk);
      dialog.removeEventListener("close", onClose);
    }

    ok.addEventListener("click", onOk);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    // Destructive by default, so Cancel takes the focus and a stray Enter is safe.
    cancel.focus();
  });
}

/* ------------------------------------------------------------------ */
/* building                                                            */
/* ------------------------------------------------------------------ */

function buildDialog() {
  const dialog = createDialog("Settings");
  const title = el("h2", null, "Settings");

  const sub = el(
    "p",
    "text-muted text-[13px]",
    "Applies to every profile.",
  );

  /* ---------- tracker: first, because it is what people come here to change ---------- */

  const tracker = group("Tracker");

  // Keyed by column id so renderPreferences and wire() do not have to know which
  // columns exist — that list lives in settings-store.js.
  const columns = new Map();
  const columnList = el("div", "flex flex-wrap gap-x-4 gap-y-1.5");
  columnList.setAttribute("role", "group");
  columnList.setAttribute("aria-label", "Columns to show");

  for (const column of COLUMNS) {
    const box = checkbox(column.label);
    columns.set(column.id, box.input);
    columnList.append(box.label);
  }

  tracker.append(
    row(
      "Columns to show",
      null,
      columnList,
    ),
  );

  const densitySeg = el("div", "seg");
  densitySeg.setAttribute("role", "group");
  densitySeg.setAttribute("aria-label", "Row density");
  tracker.append(
    row("Row density", null, densitySeg),
  );

  const hideCompleted = checkbox("Hide");
  tracker.append(
    row(
      "Hide fully caught pets by default",
      null,
      hideCompleted.label,
    ),
  );

  const defaultCategory = el("select", "min-w-[190px]");
  tracker.append(
    row(
      "Category to open by default",
      null,
      defaultCategory,
    ),
  );

  /* ---------- appearance ---------- */

  const appearance = group("Appearance");

  const modeSeg = el("div", "seg");
  modeSeg.setAttribute("role", "group");
  modeSeg.setAttribute("aria-label", "Light or dark");
  appearance.append(
    row("Light or dark", null, modeSeg),
  );

  const themeRow = el("div", "swatch-row");
  themeRow.setAttribute("role", "group");
  themeRow.setAttribute("aria-label", "Colour theme");
  appearance.append(
    row(
      "Colour theme",
      "Every theme works in both light and dark.",
      themeRow,
      "",
      true,
    ),
  );

  /* ---------- data ---------- */

  const data = group("Your data");
  data.append(
    el(
      "p",
      "setting-hint mb-3",
      "All data is held in this browser.",
    ),
  );

  const profileList = el("div", "flex flex-col");
  data.append(profileList);

  const resetButton = button("btn btn-sm btn-quiet", "Reset");
  data.append(
    row(
      "Reset settings",
      "Progress is not affected.",
      resetButton,
    ),
  );

  const eraseButton = button("btn btn-sm btn-danger", "Erase all data");
  data.append(
    row(
      "Erase all data",
      "Clears all profiles, progress, and settings.",
      eraseButton,
      "text-danger",
    ),
  );

  const body = el("div", "mt-4");
  body.append(tracker, appearance, data);

  const toastNode = buildToast();
  dialog.append(title, sub, body, toastNode);

  return {
    dialog,
    toast: toastNode,
    columns,
    hideCompleted: hideCompleted.input,
    defaultCategory,
    modeSeg,
    themeRow,
    densitySeg,
    profileList,
    resetButton,
    eraseButton,
    confirm: buildConfirm(),
  };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function update(patch) {
  settings = saveSettings(patch);
  renderPreferences();
  host.onChange?.(settings);
}

/**
 * Picking an option rebuilds the group it lives in, which throws away the very
 * button you just pressed — and with it the keyboard focus, leaving Tab to start
 * over from the top of the dialog. Hand focus to the replacement instead.
 */
function keepFocus(container, render) {
  const hadFocus = container.contains(document.activeElement);
  render();
  if (hadFocus) container.querySelector(".is-active")?.focus();
}

function renderSegment(container, choices, current, onPick) {
  keepFocus(container, () => {
    container.replaceChildren();

    for (const choice of choices) {
      const node = button(choice.id === current ? "is-active" : "", choice.label);
      node.setAttribute("aria-pressed", String(choice.id === current));
      node.addEventListener("click", () => onPick(choice.id));
      container.append(node);
    }
  });
}

/**
 * A theme's chip: its accent and its second colour, split on the diagonal. A
 * hard edge rather than a blend, so the two colours stay readable at chip size.
 */
function swatchImage([accent, second = accent]) {
  return `linear-gradient(135deg, ${accent} 0 50%, ${second} 50% 100%)`;
}

/**
 * Swatches only, in one row. No visible names, no headings: the label is set as
 * the accessible name so a screen reader still announces it, but nothing on
 * screen spells out which theme is which.
 */
function renderThemes() {
  keepFocus(ui.themeRow, () => {
    ui.themeRow.replaceChildren();

    for (const theme of THEMES) {
      const active = theme.id === settings.theme;
      const node = button(`swatch${active ? " is-active" : ""}`);
      node.style.setProperty("--swatch", swatchImage(theme.colors));
      node.setAttribute("aria-label", theme.label);
      node.setAttribute("aria-pressed", String(active));
      node.addEventListener("click", () => update({ theme: theme.id }));
      ui.themeRow.append(node);
    }
  });
}

function renderPreferences() {
  renderSegment(ui.modeSeg, MODES, settings.mode, (mode) => update({ mode }));
  renderSegment(ui.densitySeg, DENSITIES, settings.density, (density) => update({ density }));
  renderThemes();

  for (const [id, input] of ui.columns) input.checked = settings.columns?.[id] !== false;
  ui.hideCompleted.checked = settings.hideCompleted === true;
}

function renderCategoryChoices() {
  const select = ui.defaultCategory;
  select.replaceChildren();

  if (!index) {
    const loading = document.createElement("option");
    loading.textContent = "Loading categories…";
    loading.disabled = true;
    select.append(loading);
    return;
  }

  for (const category of index.categories) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.pets.length
      ? `${category.label} (${category.pets.length})`
      : `${category.label} (empty)`;
    option.disabled = category.pets.length === 0;
    select.append(option);
  }

  select.value = settings.defaultCategory;
}

function renderProfiles() {
  const container = ui.profileList;
  container.replaceChildren();

  const profiles = store.listProfiles();
  if (!profiles.length) {
    const note = el("p", "setting-hint pb-3", "No profiles yet. Create one from the tracker.");
    container.append(note);
    return;
  }

  for (const profile of profiles) {
    const progress = store.getProgress(profile.id);
    const ticks = index
      ? countProgress(index, progress).total
      : Object.values(progress).reduce((sum, v) => sum + v.length, 0);

    const label = `${ticks.toLocaleString()} ticked ${ticks === 1 ? "box" : "boxes"}`;
    const remove = button("btn btn-sm btn-quiet btn-danger", "Delete");

    remove.addEventListener("click", async () => {
      const ok = await confirmAction(
        `Delete "${profile.name}"?`,
        `This erases ${label}. It cannot be undone.`,
        "Delete profile",
      );
      if (!ok) return;

      store.deleteProfile(profile.id);
      renderProfiles();
      toast(`Deleted "${profile.name}".`);
      host.onChange?.(settings);
    });

    container.append(row(profile.name, label, remove));
  }
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function resetPreferences() {
  const ok = await confirmAction(
    "Reset settings?",
    "Profiles and progress are not affected.",
    "Reset settings",
  );
  if (!ok) return;

  settings = resetSettings();
  renderPreferences();
  renderCategoryChoices();
  toast("Settings reset.");
  host.onChange?.(settings);
}

async function eraseEverything() {
  const profiles = store.listProfiles();
  const ok = await confirmAction(
    "Erase all data?",
    `This deletes ${profiles.length} profile${profiles.length === 1 ? "" : "s"}, all ` +
      `progress, and your settings. It cannot be undone.`,
    "Erase everything",
  );
  if (!ok) return;

  try {
    // Only this site's keys — anything else on the origin is not ours to remove.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("rcu:")) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }

  settings = resetSettings();
  renderPreferences();
  renderCategoryChoices();
  renderProfiles();
  toast("All local data erased.");
  host.onChange?.(settings);
}

/* ------------------------------------------------------------------ */
/* opening                                                             */
/* ------------------------------------------------------------------ */

/**
 * The category list is the only thing here that needs pet data. The tracker
 * already has an index in memory and hands it over; anywhere else we fetch it
 * once, after the dialog is on screen, and fill the dropdown in when it lands.
 */
async function ensureIndex() {
  if (index) return;

  const supplied = host.getIndex?.();
  if (supplied) {
    index = supplied;
    return;
  }

  indexPromise ??= loadIndex().catch(() => null);
  index = await indexPromise;
}

function wire() {
  for (const [id, input] of ui.columns) {
    input.addEventListener("change", () =>
      update({ columns: { ...settings.columns, [id]: input.checked } }),
    );
  }
  ui.hideCompleted.addEventListener("change", (event) =>
    update({ hideCompleted: event.target.checked }),
  );
  ui.defaultCategory.addEventListener("change", (event) =>
    update({ defaultCategory: event.target.value }),
  );

  ui.resetButton.addEventListener("click", resetPreferences);
  ui.eraseButton.addEventListener("click", eraseEverything);
}

export async function openSettings() {
  if (!ui) {
    ui = buildDialog();
    wire();
  }

  settings = loadSettings();
  renderPreferences();
  renderCategoryChoices();
  renderProfiles();

  showDialog(ui.dialog);

  await ensureIndex();
  if (!ui.dialog.open) return;
  renderCategoryChoices();
  renderProfiles();
}

/**
 * @param {object}   [options]
 * @param {Function} [options.getIndex] Returns an already-loaded pet index, or a
 *   falsy value to have the dialog fetch its own.
 * @param {Function} [options.onChange] Called after anything is changed here, so
 *   the page underneath can catch up — a deleted profile, new defaults.
 */
export function mountSettingsModal(options = {}) {
  // The first mount wins: the editor mounts this too, and inside the editor
  // dialog that would otherwise throw away the tracker's getIndex/onChange.
  if (!mountTrigger("data-open-settings", OPEN_PARAM, openSettings)) return;
  host = options;

  // Another tab changed something. Worth listening for even before the dialog
  // has ever been built: a theme picked in one tab should reach the others.
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith("rcu:") || event.key === PROBE_KEY) return;

    settings = applySettings(loadSettings());
    if (!ui) return;
    renderPreferences();
    renderCategoryChoices();
    renderProfiles();
  });
}
