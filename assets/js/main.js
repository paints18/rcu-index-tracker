/**
 * App controller: wiring, state, and event handling.
 *
 * The dependency direction is deliberate — main.js talks to store.js, and
 * store.js is local-only: everything here works fully offline.
 */

import { loadSettings, saveSettings, applySettings } from "./settings-store.js";
import { mountHelpModal } from "./help-modal.js";
import { mountSettingsModal } from "./settings-modal.js";
import { mountUpdatesModal } from "./updates-modal.js";
import { mountAboutModal } from "./about-modal.js";
import { mountExportModal } from "./export-modal.js";
import { loadIndex, countProgress, totalsByVariant } from "./data.js";
import { Store, normalizeName, PROBE_KEY } from "./store.js";
import { encodeBackup, decodeBackup, partitionKnown } from "./backup.js";
import {
  renderCategoryNav,
  renderVariantSummary,
  renderTableHead,
  renderRows,
  syncRow,
  syncTableHead,
  fillSelect,
  fillSizer,
  percent,
} from "./ui.js";

const $ = (id) => document.getElementById(id);

const dom = {
  siteHeader: $("site-header"),
  onboard: $("onboard"),
  onboardForm: $("onboard-form"),
  onboardName: $("onboard-name"),
  onboardImport: $("onboard-import"),

  app: $("app"),
  profileName: $("profile-name"),
  profileSwitch: $("profile-switch"),
  profileEdit: $("profile-edit"),
  profileDelete: $("profile-delete"),
  openBackup: $("open-backup"),

  summaryValue: $("summary-value"),
  summaryTotal: $("summary-total"),
  summaryBar: $("summary-bar"),
  summaryBarWrap: $("summary-bar-wrap"),
  variantSummary: $("variant-summary"),

  catNav: $("cat-nav"),
  catTitle: $("cat-title"),
  catCount: $("cat-count"),

  filterSearch: $("filter-search"),
  filterEgg: $("filter-egg"),
  filterRarity: $("filter-rarity"),
  eggSizer: $("egg-sizer"),
  raritySizer: $("rarity-sizer"),
  filterStatus: $("filter-status"),
  filterReset: $("filter-reset"),

  bulkUndo: $("bulk-undo"),
  bulkHint: $("bulk-hint"),
  bulkHintDismiss: $("bulk-hint-dismiss"),

  table: $("pet-table"),
  thead: $("pet-thead"),
  tbody: $("pet-tbody"),
  emptyState: $("empty-state"),

  switchDialog: $("switch-dialog"),
  switchList: $("switch-list"),
  switchNewForm: $("switch-new-form"),
  switchNewName: $("switch-new-name"),
  switchNewError: $("switch-new-error"),

  renameDialog: $("rename-dialog"),
  renameDialogForm: $("rename-dialog-form"),
  renameDialogName: $("rename-dialog-name"),
  renameDialogError: $("rename-dialog-error"),

  deleteDialog: $("delete-dialog"),
  deleteDialogBody: $("delete-dialog-body"),
  deleteDialogConfirm: $("delete-dialog-confirm"),

  dialog: $("backup-dialog"),
  tabExport: $("tab-export"),
  tabImport: $("tab-import"),
  panelExport: $("panel-export"),
  panelImport: $("panel-import"),
  exportProfileName: $("export-profile-name"),
  exportCode: $("export-code"),
  exportMeta: $("export-meta"),
  copyCode: $("copy-code"),
  importName: $("import-name"),
  importCode: $("import-code"),
  doImport: $("do-import"),
  importStatus: $("import-status"),

  toast: $("toast"),
  toastText: $("toast-text"),
};

const store = new Store();

const state = {
  index: null,
  profileId: null,
  progress: {},
  categoryId: null,
  filters: { search: "", egg: "", rarity: "", status: "all" },
  /** Variant columns the current head was built with; syncTableHead needs them. */
  usedVariants: [],

  /**
   * Shift-click anchor, as { column, slug }. Held by SLUG rather than row index
   * or element, so it survives every re-render by construction; resolution goes
   * through the rendered rows, so an anchor that is no longer on screen simply
   * fails to resolve and the click degrades to a plain tick.
   */
  range: null,

  /**
   * Undo history for this page load, oldest first. Cleared only by a refresh.
   *
   * Entries are DELTAS — `{ profileId, categoryId, changes, caught }` — not
   * snapshots of the whole progress object, and that is what makes a stack safe
   * to keep around.
   * Undoing one re-applies `!caught` to exactly the boxes that moved, so it
   * cannot reach across and clobber anything it did not touch: not another
   * profile, and not work another tab did in the meantime. A stack of whole-
   * object snapshots could do both, which is why the single-level version had to
   * throw itself away at every one of those moments.
   *
   * The stack is one list, but it reads as one history PER profile per category:
   * the button only ever offers entries matching both (see isActiveUndoEntry),
   * so a fill in World 4 is not what Undo takes back once you are in World 2 —
   * it waits, untouched, until you go back.
   *
   * `changes` already lists only the boxes that genuinely moved (see
   * changesFor), so inverting an entry restores the previous state exactly.
   */
  undoStack: [],
};

/** Plenty for a session's worth of clicking; keeps a runaway session bounded. */
const UNDO_LIMIT = 200;

/**
 * The "no filter" option at the top of each menu. Named here because the menu's
 * width sizer has to account for it too — "All rarities" is longer than every
 * rarity there is, so a sizer built from the data alone would leave the menu too
 * narrow to show its own placeholder.
 */
const FILTER_ALL = { egg: "All eggs", rarity: "All rarities" };

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Publish the site header's real height as --header-h.
 *
 * The table's sticky <thead> parks itself directly below the sticky site header.
 * A hardcoded offset gets this wrong the moment the header wraps to two lines —
 * on narrow screens, or once the profile bar appears — leaving a gap that table
 * rows scroll through and appear on top of. Measuring keeps the two locked
 * together at every width.
 */
function measureHeader() {
  if (!dom.siteHeader) return;
  const height = Math.ceil(dom.siteHeader.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--header-h", `${height}px`);
}

function trackHeaderHeight() {
  if (!dom.siteHeader) return;

  // Measured synchronously wherever the header can change (see renderProfiles),
  // so the offset is never wrong at first paint. ResizeObserver and the resize
  // listener below only catch what synchronous calls cannot predict — font
  // swaps, zoom, and window resizes.
  measureHeader();

  if (typeof ResizeObserver === "function") {
    // border-box: padding and the bottom border count toward where the table
    // header has to sit.
    new ResizeObserver(measureHeader).observe(dom.siteHeader, { box: "border-box" });
  }
  window.addEventListener("resize", measureHeader);
  document.fonts?.ready?.then(measureHeader).catch(() => {});
}

let toastTimer = null;

/**
 * Say something that has nowhere else to appear — a deleted profile, a copied
 * backup code, storage being unavailable.
 *
 * Never for edits. Ticking boxes is self-evidently what it is: the boxes move,
 * the counts move, and Undo is always sitting in the bulk bar. A panel that slid
 * over the table on every fill only added something to read and something to
 * wait out.
 *
 * @param {string} message
 */
function toast(message) {
  // Unhide first, then write: `hidden` takes the live region out of the
  // accessibility tree, and a change made while it is out of the tree may never
  // be announced at all.
  dom.toast.hidden = false;
  dom.toastText.textContent = message;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 2600);
}

function hideToast() {
  dom.toast.hidden = true;
}

function activeCategory() {
  return state.index.categories.find((c) => c.id === state.categoryId) ?? state.index.categories[0];
}

/**
 * Pick a starting category: an explicit link wins, then the preferred category
 * from settings, then the first one that actually has pets.
 */
function initialCategoryId(index, settings) {
  const fromQuery = new URLSearchParams(location.search).get("category");
  if (fromQuery && index.categories.some((c) => c.id === fromQuery)) return fromQuery;

  const preferred = settings.defaultCategory;
  if (preferred && index.categories.some((c) => c.id === preferred && c.pets.length)) {
    return preferred;
  }

  return (index.categories.find((c) => c.pets.length) ?? index.categories[0]).id;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderProfiles() {
  const profiles = store.listProfiles();
  const hasProfiles = profiles.length > 0;

  dom.onboard.hidden = hasProfiles;
  dom.app.hidden = !hasProfiles;

  if (!hasProfiles) {
    state.profileId = null;
    measureHeader();
    return;
  }

  const active = store.getProfile(state.profileId) ?? profiles[0];
  dom.profileName.textContent = active.name;
  // Truncated names lose their tail; the tooltip is where the rest of it lives.
  dom.profileName.title = active.name;

  // Showing the profile bar grows the header, and the sticky table header has
  // to follow it. Measuring here rather than in a rAF keeps the two in step on
  // the very first paint.
  measureHeader();
}

/**
 * The rows in the switch dialog: one per profile, newest state each time it
 * opens rather than kept in sync, since nothing can change them while it is up.
 *
 * Each row carries its own tick count. Two profiles called "main" and "main2"
 * are otherwise indistinguishable, and picking the wrong one is only obvious
 * several clicks later.
 */
function renderSwitchList() {
  const profiles = store.listProfiles();
  const rows = document.createDocumentFragment();

  for (const profile of profiles) {
    const ticks = Object.values(store.getProgress(profile.id)).reduce(
      (sum, v) => sum + v.length,
      0,
    );

    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-row";
    button.dataset.profileId = profile.id;

    const name = document.createElement("span");
    name.className = "profile-row-name";
    name.textContent = profile.name;

    const count = document.createElement("span");
    count.className = "profile-row-count";
    count.textContent = `${ticks.toLocaleString()} / ${state.index.totalTicks.toLocaleString()}`;

    button.append(name, count);

    if (profile.id === state.profileId) {
      button.classList.add("is-active");
      button.setAttribute("aria-current", "true");
    }

    const item = document.createElement("li");
    item.append(button);
    rows.append(item);
  }

  dom.switchList.replaceChildren(rows);
}

function renderCounts() {
  const { index } = state;
  const counts = countProgress(index, state.progress);
  const category = activeCategory();

  // Overall
  dom.summaryValue.textContent = counts.total.toLocaleString();
  dom.summaryTotal.textContent = `/ ${index.totalTicks.toLocaleString()}`;
  const pct = percent(counts.total, index.totalTicks);
  dom.summaryBar.style.width = `${pct}%`;
  dom.summaryBarWrap.setAttribute(
    "aria-label",
    `${counts.total} of ${index.totalTicks} caught, ${pct} percent`,
  );

  dom.variantSummary.replaceChildren(
    renderVariantSummary(index.variants, counts.perVariant, totalsByVariant(index)),
  );

  // Category nav
  dom.catNav.replaceChildren(renderCategoryNav(index, counts.perCategory, category.id));

  // Current category header
  const catDone = counts.perCategory.get(category.id) ?? 0;
  dom.catTitle.textContent = category.label;
  dom.catCount.textContent = category.totalTicks
    ? `${catDone} / ${category.totalTicks} pets`
    : "No pets listed in this category yet";

  // The bulk-edit hint is for people who arrive with a full in-game index, so it
  // only ever shows on a profile that has never been ticked — it retires itself
  // the moment anyone does anything, and Dismiss makes that permanent.
  //
  // Deliberately NOT tied to whether bulk edit is on: hiding it at the moment of
  // the toggle pulled the whole table up by its height, which is exactly the
  // jump the mode is otherwise careful not to cause. It is worded to hold up
  // either way, and goes away on the first tick instead.
  const settings = loadSettings();
  dom.bulkHint.hidden = settings.bulkHintSeen || counts.total > 0;

  return counts;
}

function visiblePets(category) {
  const { search, egg, rarity, status } = state.filters;
  const needle = search.trim().toLowerCase();

  return category.pets.filter((pet) => {
    if (egg && pet.egg !== egg) return false;
    if (rarity && pet.rarity !== rarity) return false;

    if (needle) {
      const haystack = `${pet.name} ${pet.egg ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (status !== "all") {
      const caught = state.progress[pet.slug] ?? [];
      const owned = pet.variants.filter((v) => caught.includes(v)).length;
      if (status === "complete" && owned !== pet.variants.length) return false;
      if (status === "incomplete" && owned === pet.variants.length) return false;
      if (status === "untouched" && owned !== 0) return false;
    }
    return true;
  });
}

/**
 * Everything the table head reports, measured over a given set of pets.
 *
 * The head is scoped to what is on screen rather than to the whole category, so
 * that its counts and its bulk checkboxes describe the same thing. A header that
 * read "22/138" above a checkbox that only touches the 22 filtered rows would be
 * the exact confusion the checkboxes exist to remove. With no filter active —
 * the common case — the scope is the category and nothing looks different.
 *
 * @param {object[]} pets
 * @returns {import("./ui.js").HeadCounts}
 */
function headCounts(pets) {
  const done = new Map(state.index.variants.map((v) => [v.id, 0]));
  const total = new Map(state.index.variants.map((v) => [v.id, 0]));
  let full = 0;

  for (const pet of pets) {
    const caught = state.progress[pet.slug] ?? [];
    let owned = 0;
    for (const variantId of pet.variants) {
      total.set(variantId, total.get(variantId) + 1);
      if (caught.includes(variantId)) {
        done.set(variantId, done.get(variantId) + 1);
        owned += 1;
      }
    }
    if (pet.variants.length > 0 && owned === pet.variants.length) full += 1;
  }
  return { done, total, full, pets: pets.length };
}

/** Rebuild the head from scratch — only when the column set can have changed. */
function renderTableHeadFor(category, scopePets) {
  const result = renderTableHead(
    state.index.variants,
    category,
    headCounts(scopePets),
    state.index.widest,
  );
  dom.thead.replaceChildren(result.head);
  state.usedVariants = result.used;
  return result.used;
}

/**
 * Update the head in place. Used after every edit, so the checkbox the user just
 * clicked survives — replacing it would drop keyboard focus part-way through the
 * usual "Normal, then Golden, then Toxic" run.
 */
function updateTableHead() {
  const headRow = dom.thead.rows[0];
  if (headRow) syncTableHead(headRow, state.usedVariants, headCounts(renderedPets()));
}

function renderTable() {
  const category = activeCategory();
  const pets = visiblePets(category);

  // Head after rows would be tidier, but the head owns the column set the rows
  // are built against, so it has to come first; it is handed the pet list
  // directly rather than reading the DOM it is about to precede.
  const used = renderTableHeadFor(category, pets);

  dom.tbody.replaceChildren(renderRows(pets, state.progress, used, state.index.widest));
  dom.emptyState.hidden = pets.length > 0 || category.pets.length === 0;

  if (category.pets.length === 0) {
    dom.emptyState.hidden = false;
    dom.emptyState.textContent =
      "No pets listed in this category yet.";
  } else {
    dom.emptyState.textContent = "No pets match the current filters.";
  }
}

/* ---------- bulk edit ---------- */

/**
 * The pets currently rendered, read from the DOM rather than recomputed with
 * visiblePets().
 *
 * They are not the same list: a tick leaves its row in place even when it stops
 * matching the status filter (see onTick), so visiblePets() can be a pet short
 * of what is actually on screen. Everything scoped to "what you can see" — the
 * head's counts and checkboxes, and the shift-click range — has to agree with
 * the screen, and this is the only source that always does.
 */
function renderedPets() {
  const pets = [];
  for (const row of dom.tbody.rows) {
    const pet = state.index.bySlug.get(row.dataset.slug);
    if (pet) pets.push(pet);
  }
  return pets;
}

/** Slugs from the anchor to the clicked row, inclusive, in screen order. */
function rangeSlugs(fromSlug, toSlug) {
  const rows = [...dom.tbody.rows];
  const from = rows.findIndex((r) => r.dataset.slug === fromSlug);
  const to = rows.findIndex((r) => r.dataset.slug === toSlug);

  // The anchor was filtered away, or the category changed under it. Fall back to
  // a plain tick rather than guessing at a range the user cannot see.
  if (from < 0 || to < 0) return null;
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.dataset.slug);
}

/**
 * The boxes that would actually move, for a set of rows and one column.
 *
 * @param {string[]} slugs
 * @param {string} columnId A variant id, or "*" for the roll-up column — which
 *   means every variant the pet in question actually has.
 * @param {boolean} caught
 */
function changesFor(slugs, columnId, caught) {
  const changes = [];

  for (const slug of slugs) {
    const pet = state.index.bySlug.get(slug);
    if (!pet) continue;

    const owned = state.progress[slug] ?? [];
    const wanted = columnId === "*" ? pet.variants : [columnId];

    for (const variantId of wanted) {
      if (!pet.variants.includes(variantId)) continue; // this pet has no such variant
      if (owned.includes(variantId) === caught) continue; // already in that state
      changes.push({ slug, variantId });
    }
  }
  return changes;
}

/** Put a set of already-rendered rows back in line with progress. */
function refreshRows(slugs) {
  const wanted = new Set(slugs);
  for (const row of dom.tbody.rows) {
    if (!wanted.has(row.dataset.slug)) continue;
    const pet = state.index.bySlug.get(row.dataset.slug);
    if (pet) syncRow(row, pet, new Set(state.progress[row.dataset.slug] ?? []));
  }
}

/* ---------- keyboard grid navigation ---------- */

/**
 * Column keys in on-screen order: the roll-up first, then each variant the
 * head is currently showing. Mirrors the order renderTableHead/renderRows
 * build cells in, so index N here is always index N in every row.
 */
function gridColumns() {
  return ["*", ...state.usedVariants.map((v) => v.id)];
}

/**
 * Bulk-off hides the head's tick boxes with `visibility: hidden` rather than
 * `display: none` (see .vhead-tick in tailwind.css), specifically so turning
 * bulk edit on never reflows the table. That means `offsetParent` alone does
 * not detect them — a hidden box still has one — so visibility has to be
 * checked too, or navigation "focuses" a box the browser silently refuses to
 * take focus, and the keypress goes nowhere.
 */
function isFocusable(input) {
  return (
    Boolean(input) &&
    !input.disabled &&
    input.offsetParent !== null &&
    getComputedStyle(input).visibility !== "hidden"
  );
}

/**
 * The checkbox for one column of one row (header or body), or null if that
 * cell has nothing to focus — a pet without that variant leaves the <td>
 * empty, and the bulk row's boxes are unfocusable while bulk edit is off.
 */
function cellForColumn(row, columnId) {
  const input =
    row.querySelector(`input[data-bulk-column="${columnId}"]`) ??
    (columnId === "*"
      ? row.querySelector('input[data-slug]:not([data-variant])')
      : row.querySelector(`input[data-variant="${columnId}"]`));
  return isFocusable(input) ? input : null;
}

function gridRows() {
  return [dom.thead.rows[0], ...dom.tbody.rows].filter(Boolean);
}

function focusCell(input) {
  if (!input) return;
  input.focus();
  input.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Move focus one or more steps along a single axis from the checkbox the
 * keypress landed on, the way arrow keys do in a spreadsheet: stepping past
 * an empty cell (a pet without that variant, or a disabled bulk box) rather
 * than stopping there, and going no further once the grid runs out — this
 * never wraps to the opposite edge or the next row.
 *
 * @param {HTMLInputElement} current
 * @param {"row"|"col"} axis
 * @param {number} step +1 or -1
 */
function moveFocus(current, axis, step) {
  const rows = gridRows();
  const columns = gridColumns();
  const row = current.closest("tr");
  const rowIndex = rows.indexOf(row);
  const colIndex = columns.indexOf(current.dataset.bulkColumn ?? current.dataset.variant ?? "*");
  if (rowIndex < 0 || colIndex < 0) return;

  if (axis === "row") {
    for (let r = rowIndex + step; rows[r]; r += step) {
      const target = cellForColumn(rows[r], columns[colIndex]);
      if (target) return focusCell(target);
    }
  } else {
    for (let c = colIndex + step; columns[c] != null; c += step) {
      const target = cellForColumn(row, columns[c]);
      if (target) return focusCell(target);
    }
  }
}

/** Home/End: the first or last focusable box in the current row. */
function moveToRowEdge(current, end) {
  const row = current.closest("tr");
  const columns = gridColumns();
  const order = end ? [...columns].reverse() : columns;
  for (const columnId of order) {
    const target = cellForColumn(row, columnId);
    if (target) return focusCell(target);
  }
}

/** Ctrl+Home/Ctrl+End: the first or last focusable box in the whole table. */
function moveToTableEdge(end) {
  const rows = gridRows();
  const columns = gridColumns();
  const rowOrder = end ? [...rows].reverse() : rows;
  const colOrder = end ? [...columns].reverse() : columns;
  for (const row of rowOrder) {
    for (const columnId of colOrder) {
      const target = cellForColumn(row, columnId);
      if (target) return focusCell(target);
    }
  }
}

/**
 * Arrow/Home/End navigation across the tick grid, plus Enter as a shorthand
 * for "confirm this box, move to the next row" — the spreadsheet habit of
 * arrowing or tabbing across a run, then Enter-ing down to the next one.
 * Space still does the actual toggling; it is a native checkbox behaviour
 * this deliberately leaves alone.
 */
function onGridKeydown(event) {
  const input = event.target.closest('input[data-slug], input[data-bulk-column]');
  if (!input) return;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveFocus(input, "row", 1);
      break;
    case "ArrowUp":
      event.preventDefault();
      moveFocus(input, "row", -1);
      break;
    case "ArrowRight":
      event.preventDefault();
      moveFocus(input, "col", 1);
      break;
    case "ArrowLeft":
      event.preventDefault();
      moveFocus(input, "col", -1);
      break;
    case "Home":
      event.preventDefault();
      if (event.ctrlKey) moveToTableEdge(false);
      else moveToRowEdge(input, false);
      break;
    case "End":
      event.preventDefault();
      if (event.ctrlKey) moveToTableEdge(true);
      else moveToRowEdge(input, true);
      break;
    case "Enter":
      event.preventDefault();
      moveFocus(input, "row", event.shiftKey ? -1 : 1);
      break;
  }
}

/* ---------- undo history ---------- */

/**
 * Record an edit so it can be taken back later.
 *
 * Every edit goes on the stack, single ticks included — an undo history that
 * silently skipped the small edits would be worse than none, because the button
 * would look ready and then undo something you had forgotten about.
 */
function pushUndo(changes, caught) {
  if (!changes.length) return;
  state.undoStack.push({
    profileId: state.profileId,
    categoryId: activeCategory().id,
    changes,
    caught,
  });
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

/**
 * Does this entry belong to what is on screen right now?
 *
 * Both halves matter. An edit is scoped to a profile AND to the category it was
 * made in, because Undo is judged against the table you are looking at: sitting
 * in World 2 and taking back a fill from World 4 unticks rows you cannot see.
 * Entries whose profile has since been deleted never match and so can never be
 * replayed into nothing.
 */
function isActiveUndoEntry(entry) {
  return (
    entry.profileId === state.profileId &&
    entry.categoryId === activeCategory().id &&
    Boolean(store.getProfile(entry.profileId))
  );
}

/**
 * Index of the newest entry made in the profile and category on screen.
 *
 * Entries are kept when you switch profiles or categories rather than discarded,
 * so the stack can hold other views' edits; undo only ever reaches for this one.
 * Switch back and that view's history is still there, exactly where you left it.
 */
function lastUndoIndex() {
  for (let i = state.undoStack.length - 1; i >= 0; i -= 1) {
    if (isActiveUndoEntry(state.undoStack[i])) return i;
  }
  return -1;
}

/**
 * The Undo affordance that outlives the toast.
 *
 * Always present, and only ever enabled or disabled: a button that appears and
 * disappears shoves the rest of the row sideways every time you touch a
 * checkbox.
 */
function renderUndo() {
  const index = lastUndoIndex();
  dom.bulkUndo.disabled = index < 0;

  if (index < 0) {
    dom.bulkUndo.title = `Nothing to undo in ${activeCategory().label} yet`;
    return;
  }
  const entry = state.undoStack[index];
  const n = entry.changes.length;
  const depth = state.undoStack.filter(isActiveUndoEntry).length;
  dom.bulkUndo.title =
    `Undo ${entry.caught ? "marking" : "clearing"} ${n.toLocaleString()} ` +
    `${n === 1 ? "box" : "boxes"} · ${depth} to go back through`;
}

function renderFilters() {
  const category = activeCategory();
  fillSelect(dom.filterEgg, category.eggs.filter((e) => e !== "-"), {
    placeholder: FILTER_ALL.egg,
    value: state.filters.egg,
  });
  fillSelect(dom.filterRarity, category.rarities, {
    placeholder: FILTER_ALL.rarity,
    value: state.filters.rarity,
  });
  dom.filterSearch.value = state.filters.search;
  dom.filterStatus.value = state.filters.status;
}

function renderAll() {
  renderCounts();
  renderFilters();
  renderTable();
  renderUndo();
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

function switchProfile(profileId) {
  state.profileId = profileId;
  store.setActiveProfileId(profileId);
  state.progress = store.getProgress(profileId);
  // The undo history deliberately survives a profile switch — entries carry the
  // profile they belong to, and lastUndoIndex() only reaches for this one. An
  // anchor from the previous profile's table means nothing here, though.
  state.range = null;
  renderProfiles();
  renderAll();
}

function createProfile(rawName) {
  const name = normalizeName(rawName);
  if (!name) return null;

  const { profile, created } = store.createProfile(name);
  if (!created) toast(`Switched to the existing profile "${profile.name}".`);
  switchProfile(profile.id);
  return profile;
}

/**
 * The settings dialog can delete a profile or erase everything while the page
 * behind it is still showing the old one, so re-check what we are displaying
 * rather than assume it survived.
 */
function onSettingsChanged() {
  if (!state.index) return;

  if (state.profileId && !store.getProfile(state.profileId)) {
    state.profileId = store.getActiveProfileId();
  }
  state.progress = store.getProgress(state.profileId);
  // Settings can delete this profile or erase everything. The history survives,
  // but lastUndoIndex() skips entries whose profile is gone, so a deleted
  // profile's edits can never be replayed into nothing.
  state.range = null;

  renderProfiles();
  if (state.profileId) renderAll();
}

function selectCategory(categoryId) {
  const switching = categoryId !== state.categoryId;

  state.categoryId = categoryId;
  state.filters.egg = "";
  state.filters.rarity = "";

  // The undo history survives the switch — entries carry the category they were
  // made in, and lastUndoIndex() only reaches for this one, so the button now
  // speaks for this category alone and this category's edits are still waiting
  // when you come back. An anchor from the old table means nothing here, though.
  if (switching) state.range = null;

  renderAll();
}

/**
 * @param {HTMLInputElement} input
 * @param {boolean} shiftKey Was Shift held on the click that caused this change?
 */
function onTick(input, shiftKey) {
  const slug = input.dataset.slug;
  const pet = state.index.bySlug.get(slug);
  if (!pet) return;

  // The roll-up box carries no data-variant; "*" is its column id, which is what
  // lets a shift-click range run down that column too.
  const column = input.dataset.variant ?? "*";
  const caught = input.checked;

  const run =
    shiftKey && state.range?.column === column ? rangeSlugs(state.range.slug, slug) : null;
  const slugs = run ?? [slug];
  const changes = changesFor(slugs, column, caught);

  // Re-anchor on every click, shift-click included: a fill is an edit, not a
  // selection, so there is no range to keep adjusting — the next shift-click
  // carries on from where this one stopped.
  state.range = { column, slug };

  if (changes.length) {
    pushUndo(changes, caught);
    store.setManyCaught(state.profileId, changes, caught);
    state.progress = store.getProgress(state.profileId);
  }

  // Rows are updated in place and left where they are even if they no longer
  // match the active filter, so a click — including a shift-click that fills two
  // hundred rows under the pointer — never makes the row you clicked jump away.
  refreshRows(slugs);
  renderCounts();
  // Refresh the head's counts and checkbox states without rebuilding rows.
  updateTableHead();
  renderUndo();
}

/* ---------- bulk edit actions ---------- */

/**
 * A header checkbox was toggled: apply that column to every row on screen.
 *
 * The native checkbox gives the intent for free — clicking a full column
 * unchecks it and clears, clicking an empty or partial one checks it and marks —
 * so there is no Mark/Clear pair to choose between, and no separate preview
 * count to keep honest. The head's own count is the promise, and the same count
 * a moment later is the receipt.
 *
 * @param {HTMLInputElement} input
 */
function onBulkColumn(input) {
  const column = input.dataset.bulkColumn;
  const caught = input.checked;

  const slugs = renderedPets().map((p) => p.slug);
  const changes = changesFor(slugs, column, caught);
  if (!changes.length) {
    updateTableHead(); // put the box back where the data says it should be
    return;
  }

  pushUndo(changes, caught);
  store.setManyCaught(state.profileId, changes, caught);
  state.progress = store.getProgress(state.profileId);
  // The anchor is only meaningful for a run down a column; a whole-column fill
  // leaves nowhere sensible to continue from.
  state.range = null;

  // Rows are updated in place rather than re-rendered, exactly as a tick is. The
  // pointer is on the sticky head directly above them, and the usual gesture is
  // a run across the columns — Normal, then Golden, then Toxic — so the rows
  // underneath must not move between those clicks.
  refreshRows(slugs);
  renderCounts();
  updateTableHead();
  renderUndo();
}

/**
 * Take back the newest edit belonging to the profile and category on screen.
 *
 * There is no other entry point — the only Undo is the bulk bar's button, which
 * reads the same view this does — so an undo always moves boxes you are looking
 * at, and the table itself is the confirmation.
 */
function undoBulk() {
  const index = lastUndoIndex();
  if (index < 0) return;

  const [entry] = state.undoStack.splice(index, 1);
  // Invert the delta rather than restore a snapshot: this touches only the boxes
  // that entry moved, so anything done since — here or in another tab — survives.
  store.setManyCaught(entry.profileId, entry.changes, !entry.caught);
  state.progress = store.getProgress(state.profileId);
  state.range = null;

  renderCounts();
  renderTable();
  renderUndo(); // the stack just shrank; the button has to say so
}

/* ---------- profile dialogs ---------- */

function openSwitchDialog() {
  renderSwitchList();
  dom.switchNewName.value = "";
  dom.switchNewError.textContent = "";
  dom.switchDialog.showModal();

  // Focus the active row rather than the New field: switching is the common
  // errand here, and arrow keys then walk the list.
  const current = dom.switchList.querySelector(".profile-row.is-active");
  (current ?? dom.switchNewName).focus();
}

/** Create from inside the switch dialog, then switch to what was created. */
function submitSwitchNew(event) {
  event.preventDefault();
  const name = normalizeName(dom.switchNewName.value);

  if (!name) {
    dom.switchNewError.textContent = "Enter a profile name.";
    return;
  }

  dom.switchNewError.textContent = "";
  createProfile(name);
  dom.switchDialog.close();
}

function openRenameDialog() {
  const profile = store.getProfile(state.profileId);
  if (!profile) return;

  dom.renameDialogName.value = profile.name;
  dom.renameDialogError.textContent = "";

  dom.renameDialog.showModal();
  dom.renameDialogName.focus();
  dom.renameDialogName.select();
}

function submitRenameDialog(event) {
  event.preventDefault();
  const name = normalizeName(dom.renameDialogName.value);

  if (!name) {
    dom.renameDialogError.textContent = "Enter a profile name.";
    return;
  }

  try {
    store.renameProfile(state.profileId, name);
  } catch (error) {
    dom.renameDialogError.textContent = error.message;
    return;
  }

  renderProfiles();
  dom.renameDialog.close();
  toast("Profile renamed.");
}

function openDeleteDialog() {
  const profile = store.getProfile(state.profileId);
  if (!profile) return;

  const ticks = Object.values(state.progress).reduce((sum, v) => sum + v.length, 0);
  dom.deleteDialogBody.textContent =
    `"${profile.name}" has ${ticks.toLocaleString()} ticked ` +
    `${ticks === 1 ? "box" : "boxes"}.`;

  dom.deleteDialog.showModal();
  // Focus Cancel, not Delete — this dialog is destructive and a stray Enter
  // should not confirm it.
  dom.deleteDialog.querySelector("[data-close-dialog]")?.focus();
}

function confirmDelete() {
  const profile = store.getProfile(state.profileId);
  if (!profile) return;

  store.deleteProfile(profile.id);
  const next = store.getActiveProfileId();
  state.profileId = next;
  state.progress = store.getProgress(next);

  dom.deleteDialog.close();
  // Delete now opens from inside the edit-profile dialog, on top of it — if
  // that is still open, the profile it was editing no longer exists.
  if (dom.renameDialog.open) dom.renameDialog.close();
  renderProfiles();
  if (next) renderAll();
  toast(`Deleted "${profile.name}".`);
}

/* ---------- backup dialog ---------- */

function showBackupTab(which) {
  const exporting = which === "export";
  dom.tabExport.classList.toggle("is-active", exporting);
  dom.tabImport.classList.toggle("is-active", !exporting);
  dom.tabExport.setAttribute("aria-selected", String(exporting));
  dom.tabImport.setAttribute("aria-selected", String(!exporting));
  dom.panelExport.hidden = !exporting;
  dom.panelImport.hidden = exporting;
}

async function openBackupDialog(tab = "export") {
  dom.importStatus.textContent = "";
  dom.importStatus.className = "import-status";

  const profile = state.profileId ? store.getProfile(state.profileId) : null;

  if (profile) {
    dom.exportProfileName.textContent = profile.name;
    dom.exportCode.value = "Generating…";
    dom.tabExport.disabled = false;
  } else {
    // No profile yet — import is the only sensible option.
    dom.exportProfileName.textContent = "—";
    dom.exportCode.value = "";
    dom.exportMeta.textContent = "Create a profile before exporting a backup code.";
    tab = "import";
  }

  showBackupTab(tab);
  dom.dialog.showModal();

  if (!profile) return;

  try {
    const code = await encodeBackup(profile.name, state.progress, state.index);
    dom.exportCode.value = code;

    const ticks = Object.values(state.progress).reduce((sum, v) => sum + v.length, 0);
    dom.exportMeta.textContent = `${ticks.toLocaleString()} ticked ${
      ticks === 1 ? "box" : "boxes"
    } · ${code.length.toLocaleString()} characters`;
  } catch (error) {
    dom.exportCode.value = "";
    dom.exportMeta.textContent = `Could not generate a backup code: ${error.message}`;
  }
}

async function runImport() {
  const setStatus = (message, kind) => {
    dom.importStatus.textContent = message;
    dom.importStatus.className = `import-status${kind ? ` is-${kind}` : ""}`;
  };

  let decoded;
  try {
    decoded = await decodeBackup(dom.importCode.value, state.index);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const targetName = normalizeName(dom.importName.value) || decoded.name;
  if (!targetName) {
    setStatus("Enter a name for the imported profile.", "error");
    return;
  }

  const { known, unknown } = partitionKnown(decoded.progress, (slug) =>
    state.index.bySlug.has(slug),
  );

  const { profile } = store.createProfile(targetName);
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value ?? "merge";

  let added;
  if (mode === "replace") {
    store.setProgress(profile.id, known);
    added = Object.values(known).reduce((sum, v) => sum + v.length, 0);
  } else {
    added = store.mergeProgress(profile.id, known);
  }

  switchProfile(profile.id);

  let message = `Imported ${added.toLocaleString()} ${added === 1 ? "tick" : "ticks"} into "${profile.name}".`;
  if (unknown.length) {
    // Never silently drop ticks — an unknown slug means the code predates a data
    // change, and the user should know some progress could not be placed.
    message += ` ${unknown.length} ${
      unknown.length === 1 ? "pet was" : "pets were"
    } skipped: not in the current pet list.`;
    console.warn("Unknown slugs in imported backup code:", unknown);
  }
  setStatus(message, "ok");
  toast("Backup code imported.");
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function wireEvents() {
  dom.onboardForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createProfile(dom.onboardName.value);
    dom.onboardName.value = "";
  });

  dom.onboardImport.addEventListener("click", () => openBackupDialog("import"));

  dom.profileSwitch.addEventListener("click", openSwitchDialog);
  dom.profileEdit.addEventListener("click", openRenameDialog);
  dom.profileDelete.addEventListener("click", openDeleteDialog);

  dom.switchList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-profile-id]");
    if (!row) return;
    dom.switchDialog.close();
    // Picking the one already active is a no-op, but closing on it is still the
    // right answer — the dialog did what it was opened to do.
    if (row.dataset.profileId !== state.profileId) switchProfile(row.dataset.profileId);
  });
  dom.switchNewForm.addEventListener("submit", submitSwitchNew);

  dom.renameDialogForm.addEventListener("submit", submitRenameDialog);
  dom.deleteDialogConfirm.addEventListener("click", confirmDelete);

  // Any button marked data-close-dialog closes the dialog it sits in.
  document.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-close-dialog]");
    if (closer) closer.closest("dialog")?.close();
  });

  dom.openBackup.addEventListener("click", () => openBackupDialog("export"));
  dom.tabExport.addEventListener("click", () => showBackupTab("export"));
  dom.tabImport.addEventListener("click", () => showBackupTab("import"));
  dom.doImport.addEventListener("click", runImport);

  dom.copyCode.addEventListener("click", async () => {
    if (!dom.exportCode.value) return;
    try {
      await navigator.clipboard.writeText(dom.exportCode.value);
      toast("Backup code copied.");
    } catch {
      // Clipboard API needs a secure context; selecting the text is the fallback.
      dom.exportCode.select();
      toast("Press Ctrl+C to copy.");
    }
  });

  dom.catNav.addEventListener("click", (event) => {
    const pill = event.target.closest("[data-category-id]");
    if (pill) selectCategory(pill.dataset.categoryId);
  });

  // `change` is the event we commit on — it is also what a keyboard Space
  // produces — but it does not carry modifier keys. A checkbox always fires
  // `click` first, so the modifier is stashed there and read a moment later.
  let shiftOnClick = false;
  dom.tbody.addEventListener("click", (event) => {
    const input = event.target.closest('input[type="checkbox"][data-slug]');
    if (!input) return;
    shiftOnClick = event.shiftKey;
    // Shift-clicking inside a table otherwise extends the text selection from
    // the previous click, leaving half the table highlighted.
    if (event.shiftKey) window.getSelection()?.removeAllRanges();
  });

  dom.tbody.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"][data-slug]');
    if (!input) return;
    const shiftKey = shiftOnClick;
    shiftOnClick = false;
    onTick(input, shiftKey);
  });

  // The head's bulk checkboxes. Separate from the tbody listener above because
  // they are scoped to a whole column rather than to a row, and they never take
  // part in shift-click ranges.
  dom.thead.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-bulk-column]");
    if (input) onBulkColumn(input);
  });

  // Arrow/Home/End/Enter move focus around the tick grid; shared by the head's
  // bulk row and the body since both hold the same kind of checkbox.
  dom.table.addEventListener("keydown", onGridKeydown);

  // Wrapped: the listener's MouseEvent must not land in undoBulk's entry slot.
  dom.bulkUndo.addEventListener("click", () => undoBulk());

  dom.bulkHintDismiss.addEventListener("click", () => {
    saveSettings({ bulkHintSeen: true });
    dom.bulkHint.hidden = true;
  });

  let searchTimer = null;
  dom.filterSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = dom.filterSearch.value;
      renderTable();
    }, 120);
  });

  dom.filterEgg.addEventListener("change", () => {
    state.filters.egg = dom.filterEgg.value;
    renderTable();
  });
  dom.filterRarity.addEventListener("change", () => {
    state.filters.rarity = dom.filterRarity.value;
    renderTable();
  });
  dom.filterStatus.addEventListener("change", () => {
    state.filters.status = dom.filterStatus.value;
    renderTable();
  });
  dom.filterReset.addEventListener("click", () => {
    // "Reset" means back to your configured default, not back to showing
    // everything — otherwise it would undo the hide-completed preference.
    const status = loadSettings().hideCompleted ? "incomplete" : "all";
    state.filters = { search: "", egg: "", rarity: "", status };
    renderFilters();
    renderTable();
  });

  // Another tab edited the same profile — pick up its changes.
  window.addEventListener("storage", (event) => {
    if (!event.key || !event.key.startsWith("rcu:v1:") || event.key === PROBE_KEY) return;
    state.progress = store.getProgress(state.profileId);
    // The history survives another tab's write. It could not when undo restored
    // a whole snapshot — that would have clobbered their work — but a delta only
    // ever touches the boxes it originally moved.
    renderProfiles();
    if (state.profileId) renderAll();
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // Mounted before the data load so the nav still works if the pet list fails.
  // Settings and About get our index so neither fetches pets.json a second time.
  mountHelpModal();
  mountSettingsModal({ getIndex: () => state.index, onChange: onSettingsChanged });
  mountUpdatesModal();
  mountAboutModal({ getIndex: () => state.index });
  mountExportModal({
    getIndex: () => state.index,
    getProfileId: () => state.profileId,
    getProgress: () => state.progress,
    getActiveCategory: () => (state.index ? activeCategory() : null),
    getFilters: () => state.filters,
    filterPets: (category) => visiblePets(category),
  });

  try {
    state.index = await loadIndex();
  } catch (error) {
    document.querySelector("main").innerHTML =
      `<p class="card" style="margin:40px 0">Could not load the pet list. ${error.message}</p>`;
    return;
  }

  // The inline snippet in <head> applies only the settings that would flash if
  // they arrived late (theme, density, columns); this is idempotent with it.
  const settings = applySettings(loadSettings());

  // Once, not per render: the samples come from the whole dataset, which cannot
  // change while the page is open.
  fillSizer(dom.eggSizer, [...state.index.widest.egg, FILTER_ALL.egg]);
  fillSizer(dom.raritySizer, [...state.index.widest.rarity, FILTER_ALL.rarity]);

  state.categoryId = initialCategoryId(state.index, settings);
  if (settings.hideCompleted) state.filters.status = "incomplete";
  state.profileId = store.getActiveProfileId();
  state.progress = store.getProgress(state.profileId);

  if (!store.storageAvailable) {
    toast("Local storage is blocked. Progress will not be saved.");
  }

  trackHeaderHeight();
  wireEvents();
  renderProfiles();
  if (state.profileId) renderAll();
  else dom.onboardName.focus();
}

boot();
