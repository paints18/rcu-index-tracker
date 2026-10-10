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
import { maybeShowWhatsNew } from "./whats-new.js";
import { mountAboutModal } from "./about-modal.js";
import { mountExportModal } from "./export-modal.js";
import { loadIndex, countProgress, totalsByVariant, sourceOptions } from "./data.js";
import { Store, normalizeName, PROBE_KEY } from "./store.js";
import { encodeBackup, decodeBackup, partitionKnown } from "./backup.js";
import { fetchPlayerIndex, entriesToProgress, ApiImportError } from "./api-import.js";
import {
  renderGrid,
  clearGrid,
  countGrid,
  focusGridPet,
  syncTile,
  loadPetImages,
  attachHoverCard,
  attachGridKeys,
  attachGridWindow,
} from "./grid-view.js";
import {
  renderCategoryNav,
  renderVariantSummary,
  renderTableHead,
  renderRows,
  syncRow,
  syncTableHead,
  fillSizer,
  mountMenu,
  usedVariants,
  percent,
} from "./ui.js";

const $ = (id) => document.getElementById(id);

const dom = {
  siteHeader: $("site-header"),
  onboard: $("onboard"),
  onboardName: $("onboard-name"),
  onboardShowApi: $("onboard-show-api"),
  onboardShowManual: $("onboard-show-manual"),
  onboardPanelApi: $("onboard-panel-api"),
  onboardPanelManual: $("onboard-panel-manual"),
  onboardImport: $("onboard-import"),
  onboardManual: $("onboard-manual"),
  onboardApiForm: $("onboard-api-form"),

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
  sourceSizer: $("source-sizer"),
  raritySizer: $("rarity-sizer"),
  statusSizer: $("status-sizer"),
  missingSizer: $("missing-sizer"),
  filterReset: $("filter-reset"),

  bulkUndo: $("bulk-undo"),
  bulkHint: $("bulk-hint"),
  bulkHintDismiss: $("bulk-hint-dismiss"),

  table: $("pet-table"),
  thead: $("pet-thead"),
  tbody: $("pet-tbody"),
  emptyState: $("empty-state"),

  listView: $("list-view"),
  gridView: $("grid-view"),
  viewButtons: [...document.querySelectorAll("[data-view]")],
  gridVariants: $("gv-variants"),
  gridCount: $("gv-count"),
  grid: $("gv-grid"),
  gridEmpty: $("gv-empty"),

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
  tabApi: $("tab-api"),
  panelApi: $("panel-api"),
  apiRefresh: $("api-refresh"),
  apiSync: $("api-sync"),
  syncDialog: $("sync-dialog"),
  syncApiForm: $("sync-api-form"),
  lockNote: $("lock-note"),
  lockNoteDismiss: $("lock-note-dismiss"),
  renameDialogTokenWrap: $("rename-dialog-token-wrap"),
  renameDialogToken: $("rename-dialog-token"),
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
  filters: { search: "", sources: [], rarities: [], status: "all", missing: [] },
  /** List grouped by source (the Source header is toggled on) rather than in the data's own order. */
  sortBySource: false,
  /** Variant columns the current head was built with; syncTableHead needs them. */
  usedVariants: [],

  /** "grid" (the in-game index layout, the default) or "list" (the checklist table). */
  view: "grid",
  /** Variant the grid is showing; falls back per category (see gridVariant). */
  gridVariantId: "normal",
  /** slug -> asset ids, loaded the first time the grid is opened. */
  petImages: {},

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
 * The "no filter" option at the top of each menu. Named here because the
 * Source/Rarity menus' width sizers have to account for it too — "All rarities"
 * is longer than every rarity there is, so a sizer built from the data alone
 * would leave the menu too narrow to show its own placeholder.
 *
 * Missing breaks the "All ___" pattern on purpose: "Missing" is a state verb,
 * so "Missing: All variants" reads as "missing every variant" — a real,
 * different status (see "Not indexed") — rather than "not filtering by this
 * at all". "No filter" doesn't parse as a variant name, so it can't be
 * misread that way, even though it costs the visual parallel with Source/Rarity.
 */
const FILTER_ALL = { source: "All sources", rarity: "All rarities", missing: "No filter" };

const STATUS_OPTIONS = [
  { value: "all", label: "All pets" },
  { value: "incomplete", label: "Incomplete" },
  { value: "complete", label: "Complete" },
  { value: "untouched", label: "Not indexed" },
  { value: "missing", label: "Missing" },
];

/**
 * Status choices for the view on screen. The grid shows one variant at a time, so
 * "incomplete", "complete" and "not indexed" (judged across every variant of a
 * pet) have nothing to say there. It gets "missing" instead: pets you have not
 * ticked for the variant on show, so it follows the Normal/Golden/Toxic/Galaxy
 * buttons. The list has no use for that one, its Missing menu does the job.
 */
function statusOptions() {
  const grid = state.view === "grid";
  return STATUS_OPTIONS.filter((o) => o.value === "all" || (o.value === "missing") === grid);
}

/** The variants this category has. */
function missingOptions(variants = usedVariants(state.index.variants, activeCategory())) {
  return variants.map((v) => ({ value: v.id, label: v.label }));
}

/** The filter menus. Source, rarity and missing take several values, so they are checklists. */
const menus = {
  source: mountMenu({
    button: $("filter-source"),
    panel: $("source-panel"),
    searchLabel: "Search sources or categories",
    multiple: true,
    allLabel: FILTER_ALL.source,
    countLabel: (n) => `${n} sources`,
    onChange: (value) => {
      state.filters.sources = value;
      renderBody();
    },
  }),
  rarity: mountMenu({
    button: $("filter-rarity"),
    panel: $("rarity-panel"),
    multiple: true,
    allLabel: FILTER_ALL.rarity,
    countLabel: (n) => `${n} rarities`,
    onChange: (value) => {
      state.filters.rarities = value;
      renderBody();
    },
  }),
  status: mountMenu({
    button: $("filter-status"),
    panel: $("status-panel"),
    onChange: (value) => {
      state.filters.status = value;
      renderBody();
    },
  }),
  missing: mountMenu({
    button: $("filter-missing"),
    panel: $("missing-panel"),
    multiple: true,
    allLabel: FILTER_ALL.missing,
    countLabel: (n) => `${n} variants`,
    onChange: (value) => {
      state.filters.missing = value;
      renderBody();
    },
  }),
};

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
    // The last profile may have been a linked one: its username and token must
    // not linger in the first-run form, nor its Disconnect button and lock.
    for (const form of apiForms) {
      if (form.disconnect.hidden) continue;
      form.user.value = "";
      form.token.value = "";
      setApiStatus(form, "");
    }
    renderApiLink();
    measureHeader();
    return;
  }

  const active = store.getProfile(state.profileId) ?? profiles[0];
  dom.profileName.textContent = active.name;
  // Truncated names lose their tail; the tooltip is where the rest of it lives.
  dom.profileName.title = active.name;
  renderApiLink();

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
  const { search, missing } = state.filters;
  // Source and rarity picks carry over between categories; the ones this category
  // does not list simply do not apply here.
  const sources = state.filters.sources.filter((s) => category.sources.includes(s));
  const rarities = state.filters.rarities.filter((r) => category.rarities.includes(r));
  // A status the grid does not offer (say, hide-completed carried over from the
  // list) is set aside there rather than filtering with no way to see or undo it.
  const status = statusOptions().some((o) => o.value === state.filters.status)
    ? state.filters.status
    : "all";
  const needle = search.trim().toLowerCase();

  return category.pets.filter((pet) => {
    if (sources.length && !sources.includes(pet.source)) return false;
    if (rarities.length && !rarities.includes(pet.rarity)) return false;

    if (needle) {
      const haystack = `${pet.name} ${pet.source ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    const caught = state.progress[pet.slug] ?? [];

    if (status === "missing") {
      const variantId = gridVariant()?.id;
      if (!pet.variants.includes(variantId) || caught.includes(variantId)) return false;
    } else if (status !== "all") {
      const owned = pet.variants.filter((v) => caught.includes(v)).length;
      if (status === "complete" && owned !== pet.variants.length) return false;
      if (status === "incomplete" && owned === pet.variants.length) return false;
      if (status === "untouched" && owned !== 0) return false;
    }

    // A pet matches while it is missing any ticked variant. A pet without a
    // variant at all isn't "missing" it — there is nothing to tick — so that
    // variant never makes it a match.
    if (missing.length && !missing.some((v) => pet.variants.includes(v) && !caught.includes(v))) return false;
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
  if (!headRow) return;
  syncTableHead(headRow, state.usedVariants, headCounts(renderedPets()));
  if (isLocked()) for (const input of headRow.querySelectorAll("input")) input.setAttribute("aria-disabled", "true");
}

/** Whether the Source column is showing; with it hidden there is nothing to sort by. */
function sourceColumnShown() {
  return !(document.documentElement.dataset.hideCols ?? "").split(" ").includes("source");
}

/**
 * The pets grouped by source when the Source header is on, otherwise in the data's own
 * order. Not alphabetical: sources are ranked by where each first appears in the
 * category's own list (the in-game order), so every source's pets come together and
 * the sources keep that order. Pets with no source go last, and pets of one source keep
 * their list order.
 */
function sortPets(pets, category) {
  if (!state.sortBySource || !sourceColumnShown()) return pets;

  const rank = new Map();
  for (const pet of category.pets) {
    if (pet.source && pet.source !== "-" && !rank.has(pet.source)) rank.set(pet.source, rank.size);
  }
  const at = (pet) => rank.get(pet.source) ?? rank.size;
  return [...pets].sort((a, b) => at(a) - at(b));
}

/** Mark the Source header when it is sorting, for the arrow and for screen readers. */
function syncSortHeads() {
  const th = dom.thead.querySelector("th.col-source");
  if (state.sortBySource && sourceColumnShown()) th?.setAttribute("aria-sort", "ascending");
  else th?.removeAttribute("aria-sort");
}

function renderTable() {
  const category = activeCategory();
  const pets = sortPets(visiblePets(category), category);

  // Head after rows would be tidier, but the head owns the column set the rows
  // are built against, so it has to come first; it is handed the pet list
  // directly rather than reading the DOM it is about to precede.
  const used = renderTableHeadFor(category, pets);
  syncSortHeads();

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
  // Undo is an edit like any other, so a locked profile cannot use it either.
  dom.bulkUndo.disabled = index < 0 || isLocked();

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
  menus.source.setOptions(sourceOptions(state.index, category), state.filters.sources);
  menus.rarity.setOptions(category.rarities, state.filters.rarities);
  // Same variant set the tick columns show for this category (see
  // renderTableHead) — never an option guaranteed to match nothing.
  const variants = usedVariants(state.index.variants, category);
  menus.missing.setOptions(missingOptions(variants), state.filters.missing);
  menus.status.setOptions(statusOptions(), state.filters.status);
  dom.filterSearch.value = state.filters.search;
}

function renderAll() {
  renderCounts();
  renderFilters();
  renderBody();
  renderUndo();
}

/* ---------- grid view ---------- */

const VIEW_KEY = "rcu:v1:view";

function initialView() {
  const fromQuery = new URLSearchParams(location.search).get("view");
  if (fromQuery === "grid" || fromQuery === "list") return fromQuery;
  try {
    // Grid unless the visitor has picked the list.
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** The grid shows one variant at a time; use the chosen one if this category has it. */
function gridVariant() {
  const used = usedVariants(state.index.variants, activeCategory());
  return used.find((v) => v.id === state.gridVariantId) ?? used[0] ?? null;
}

/** Whichever of the two views is showing; the table is not built while hidden. */
function renderBody() {
  if (state.view === "grid") renderGridView();
  else renderTable();
  applyLock();
}

function renderGridView() {
  const category = activeCategory();
  const variant = gridVariant();
  const pets = visiblePets(category);

  dom.gridVariants.replaceChildren(
    ...usedVariants(state.index.variants, category).map((v) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-sm btn-toggle";
      button.dataset.gridVariant = v.id;
      button.dataset.variant = v.id;
      button.textContent = v.label;
      button.setAttribute("aria-pressed", String(v.id === variant?.id));
      return button;
    }),
  );

  if (!variant) {
    clearGrid(dom.grid);
    dom.gridCount.textContent = "";
    dom.gridEmpty.textContent = "No pets listed in this category yet.";
    dom.gridEmpty.hidden = false;
    return;
  }
  dom.gridEmpty.textContent = "No pets match the current filters.";

  // Progress is passed as a function: tiles are drawn as you scroll, and state.progress
  // is replaced on every edit.
  const { done, total } = renderGrid(dom.grid, pets, () => state.progress, variant, state.petImages);
  dom.gridCount.textContent = `${variant.label} collected (${done}/${total})`;
  dom.gridEmpty.hidden = total > 0;
}

/**
 * Show another variant in the grid. If a tile had focus, focus moves to the same
 * pet in the new variant, so keyboard users keep their place.
 */
function setGridVariant(variantId) {
  const slug = dom.grid.contains(document.activeElement)
    ? document.activeElement.dataset.slug
    : null;
  state.gridVariantId = variantId;
  renderGridView();
  applyLock(); // the new tiles need the locked state too
  if (slug) focusGridPet(slug);
}

function updateGridCount() {
  const variant = gridVariant();
  if (!variant) return;
  const { done, total } = countGrid();
  dom.gridCount.textContent = `${variant.label} collected (${done}/${total})`;
}

/**
 * The grid has a row of variant buttons above its panel and the list has not, so the
 * list's window is made that much taller and both views end at the same bottom edge.
 * The row's height is not fixed — it wraps onto two lines on a phone — and it cannot
 * be measured while the grid is hidden, so an invisible copy in the page is measured
 * instead (see #gv-bar-twin) and published as --gv-bar-h for grid-view.css.
 */
function syncListHeight() {
  const twin = $("gv-bar-twin");
  const views = twin?.parentElement;
  if (!twin || !views) return;
  const publish = () => {
    const margin = parseFloat(getComputedStyle(twin).marginBottom) || 0;
    views.style.setProperty("--gv-bar-h", `${twin.getBoundingClientRect().height + margin}px`);
  };
  publish();
  if (typeof ResizeObserver === "function") new ResizeObserver(publish).observe(twin);
  document.fonts?.ready?.then(publish).catch(() => {});
}

function applyView() {
  const grid = state.view === "grid";
  dom.listView.hidden = grid;
  dom.gridView.hidden = !grid;
  for (const button of dom.viewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
  // The grid already shows one variant at a time, so its Missing menu is turned
  // off and cleared; a Missing choice made in the list does not come back.
  if (grid) state.filters.missing = [];
  menus.status.setOptions(statusOptions(), state.filters.status);
  menus.missing.setOptions(missingOptions(), state.filters.missing);
  menus.missing.setDisabled(grid);
}

async function setView(view) {
  if (view === state.view) return;
  state.view = view;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not persisted in private mode; the choice still holds for this visit.
  }
  // Hold the page at its current height while the views swap. For a moment the one
  // coming in is empty or stale, a shorter page clamps the scroll position, and you
  // would be thrown back to the top and stay there.
  const views = dom.listView.parentElement;
  views.style.minHeight = `${views.offsetHeight}px`;
  try {
    applyView();
    if (view === "grid") state.petImages = await loadPetImages();
    if (state.index && state.profileId) renderBody();
  } finally {
    views.style.minHeight = "";
  }
}

/** A tile was clicked: flip that pet's tick for the grid's variant. */
function onGridToggle(tile) {
  if (isLocked()) {
    toast(LOCKED_MESSAGE);
    return;
  }
  const { slug, variant: variantId } = tile.dataset;
  const pet = state.index.bySlug.get(slug);
  if (!pet) return;

  const caught = !(state.progress[slug] ?? []).includes(variantId);
  const changes = changesFor([slug], variantId, caught);
  if (!changes.length) return;

  pushUndo(changes, caught);
  store.setManyCaught(state.profileId, changes, caught);
  state.progress = store.getProgress(state.profileId);

  // The tile is updated in place and left where it is even if it no longer
  // matches the status filter, same as a table row; see onTick.
  syncTile(tile, caught, pet, state.index.variants.find((v) => v.id === variantId));
  renderCounts();
  updateGridCount();
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

function showOnboardTab(which) {
  const api = which === "api";
  dom.onboardPanelApi.hidden = !api;
  dom.onboardPanelManual.hidden = api;
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

  // Filters follow you from category to category. Source and rarity picks are kept
  // even where a category lacks them (visiblePets and the menus skip what is not
  // there, so they are back when you return). A variant id means the same thing
  // everywhere, but it is dropped if the category you landed in does not have
  // that variant, which would otherwise leave the filter applying to a menu
  // that does not show it.
  const variantIds = usedVariants(state.index.variants, activeCategory()).map((v) => v.id);
  state.filters.missing = state.filters.missing.filter((id) => variantIds.includes(id));

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
  if (isLocked()) {
    input.checked = !input.checked;
    toast(LOCKED_MESSAGE);
    return;
  }
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

/* ---------- shortcuts ---------- */

/** Is focus somewhere the user is typing, where single keys must be left alone? */
function isTyping(el) {
  if (!(el instanceof Element)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return (
    el.tagName === "INPUT" &&
    !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(el.type)
  );
}

/**
 * Page-wide shortcuts, shared by both views:
 *   1-4        grid only: show the Normal / Golden / Toxic / Galaxy variant
 *   /          focus the search box
 *   Ctrl+Z     Undo (Cmd+Z on macOS)
 *
 * All of them stand down while typing in a field and while a dialog is open.
 */
function onShortcut(event) {
  if (event.defaultPrevented || event.isComposing || dom.app.hidden) return;
  if (event.altKey || isTyping(event.target) || document.querySelector("dialog[open]")) return;

  const mod = event.ctrlKey || event.metaKey;

  if (mod && !event.shiftKey && event.key.toLowerCase() === "z") {
    if (event.repeat || dom.bulkUndo.disabled) return;
    event.preventDefault();
    undoBulk();
    return;
  }
  if (mod || event.shiftKey) return;

  if (event.key === "/") {
    event.preventDefault();
    dom.filterSearch.focus();
    dom.filterSearch.select();
    return;
  }

  if (state.view === "grid" && /^[1-9]$/.test(event.key)) {
    const variant = state.index.variants[Number(event.key) - 1];
    const shown = usedVariants(state.index.variants, activeCategory());
    if (!variant || !shown.some((v) => v.id === variant.id)) return;
    event.preventDefault();
    if (variant.id !== gridVariant()?.id) setGridVariant(variant.id);
  }
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
  if (isLocked()) {
    updateTableHead(); // put the box back where the data says it should be
    toast(LOCKED_MESSAGE);
    return;
  }
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
  if (index < 0 || isLocked()) return;

  const [entry] = state.undoStack.splice(index, 1);
  // Invert the delta rather than restore a snapshot: this touches only the boxes
  // that entry moved, so anything done since — here or in another tab — survives.
  store.setManyCaught(entry.profileId, entry.changes, !entry.caught);
  state.progress = store.getProgress(state.profileId);
  state.range = null;

  renderCounts();
  renderBody();
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

  const link = store.getLink(profile.id);
  dom.renameDialogTokenWrap.hidden = !link;
  dom.renameDialogToken.value = link?.token ?? "";

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

  // Only a linked profile shows the field. An emptied field keeps the old token
  // rather than saving a blank one the next refresh would fail on.
  const link = store.getLink(state.profileId);
  const token = dom.renameDialogToken.value.trim();
  if (link && token && token !== link.token) {
    store.setLink(state.profileId, { ...link, token });
    fillApiForms();
  }

  renderProfiles();
  dom.renameDialog.close();
  toast("Profile saved.");
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
  const tabs = [
    [dom.tabApi, dom.panelApi, "api"],
    [dom.tabExport, dom.panelExport, "export"],
    [dom.tabImport, dom.panelImport, "import"],
  ];
  for (const [tab, panel, name] of tabs) {
    const active = name === which;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
  if (which === "api") fillApiForms();
}

async function openBackupDialog(tab = "api") {
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
    if (tab === "export") tab = "import";
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

/* ---------- API import ---------- */

let apiBusy = false;

/**
 * The API form appears twice — in the onboarding card and in the backup dialog —
 * cloned from one template. Every instance is kept here so state changes reach
 * both.
 */
const apiForms = [];

function mountApiForm(host, { naming = false, onSuccess = null, dismissLabel = "" } = {}) {
  const root = document.getElementById("api-form-template").content.cloneNode(true);
  const field = (name) => root.querySelector(`[data-api="${name}"]`);
  const form = {
    user: field("user"),
    token: field("token"),
    connect: field("connect"),
    disconnect: field("disconnect"),
    status: field("status"),
    target: field("target"),
    currentName: field("current-name"),
    // Shown only where the import makes the profile (first run). Elsewhere it
    // imports into the active profile and has no name to ask for.
    nameWrap: field("name-wrap"),
    name: field("name"),
    onSuccess,
  };
  form.nameWrap.hidden = !naming;

  // A button after the import ones that just closes the dialog the form sits in.
  if (dismissLabel) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn btn-quiet";
    dismiss.textContent = dismissLabel;
    dismiss.setAttribute("data-close-dialog", "");
    field("actions").append(dismiss);
  }

  form.connect.addEventListener("click", () => runApiConnect(form));
  // The fields are not in a <form>, so Enter would otherwise do nothing.
  for (const input of [form.user, form.token, form.name]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") runApiConnect(form);
    });
  }
  form.disconnect.addEventListener("click", runApiDisconnect);

  host.append(root);
  apiForms.push(form);
  return form;
}

function setApiStatus(form, message, kind) {
  form.status.textContent = message;
  form.status.className = `text-[13px] empty:hidden import-status${kind ? ` is-${kind}` : ""}`;
}

/**
 * A locked profile cannot be edited by hand. Profiles imported from the API are
 * locked by default, since the game is the source of truth; any profile can be
 * locked or unlocked from Settings > Your data (see Store.isLocked).
 */
function isLocked() {
  return Boolean(state.profileId && store.isLocked(state.profileId));
}

const LOCKED_MESSAGE = "Ticks are locked on this profile. Unlock it in Settings > Your data.";

/**
 * Mark the tick boxes and grid tiles to match isLocked().
 *
 * The boxes are marked aria-disabled rather than disabled: a disabled input
 * swallows the click, so there would be nothing to tell the user why it did not
 * react. onTick and onBulkColumn put the box back and explain instead.
 */
function applyLock() {
  const locked = isLocked();
  document.documentElement.toggleAttribute("data-ticks-locked", locked);
  for (const tile of dom.grid.children) tile.setAttribute("aria-disabled", String(locked));
  if (state.index && state.profileId) renderUndo();
  dom.lockNote.hidden = !locked || loadSettings().lockNoteDismissed === true;
  for (const input of document.querySelectorAll("#app .tick input")) {
    if (locked) input.setAttribute("aria-disabled", "true");
    else input.removeAttribute("aria-disabled");
  }
}

/** Show or hide the controls that only make sense for a linked profile. */
function renderApiLink() {
  const link = state.profileId ? store.getLink(state.profileId) : null;
  const profile = state.profileId ? store.getProfile(state.profileId) : null;
  dom.apiRefresh.hidden = !link;
  // The other half of that slot: a profile with no link offers the way to make one.
  dom.apiSync.hidden = !profile || Boolean(link);
  applyLock();
  for (const form of apiForms) {
    form.disconnect.hidden = !link;
    // With no profile yet there is nothing to choose: the import makes one.
    form.target.hidden = !profile;
    form.currentName.textContent = profile?.name ?? "";
  }
}

function fillApiForms() {
  const link = state.profileId ? store.getLink(state.profileId) : null;
  for (const form of apiForms) {
    form.user.value = link?.user ?? "";
    form.token.value = link?.token ?? "";
    setApiStatus(form, "");
  }
  renderApiLink();
}

function setApiBusy(busy) {
  apiBusy = busy;
  for (const form of apiForms) form.connect.disabled = busy;
  dom.apiRefresh.disabled = busy;
  // An icon button: the label lives in aria-label/title, and the arrows spin while busy.
  const label = busy ? "Refreshing from game…" : "Refresh from game";
  dom.apiRefresh.setAttribute("aria-label", label);
  dom.apiRefresh.title = label;
  dom.apiRefresh.setAttribute("aria-busy", String(busy));
  dom.apiRefresh.querySelector("svg").classList.toggle("animate-spin", busy);
}

const countTicks = (progress) => Object.values(progress).reduce((sum, v) => sum + v.length, 0);

/**
 * Work out what importing an API response would do to a profile, without doing it.
 *
 * The in-game index is the source of truth: the profile's ticks become exactly
 * what the API reports, so a tick that is not in the game is removed. An empty
 * result for a profile that has ticks is refused instead — a failed or partial
 * API response must never be able to wipe a checklist.
 */
function planApiIndex(profileId, body) {
  const { progress, unmatched, unsupported } = entriesToProgress(body.index, state.index);
  const current = store.getProgress(profileId);

  let added = 0;
  let removed = 0;
  for (const [slug, variants] of Object.entries(progress)) {
    const had = new Set(current[slug] ?? []);
    for (const v of variants) if (!had.has(v)) added += 1;
  }
  for (const [slug, variants] of Object.entries(current)) {
    const wanted = new Set(progress[slug] ?? []);
    for (const v of variants) if (!wanted.has(v)) removed += 1;
  }

  if (countTicks(progress) === 0 && countTicks(current) > 0) {
    throw new ApiImportError("The API reported no pets for this player, so nothing was changed.");
  }
  return { progress, added, removed, unmatched, unsupported };
}

/** Replace a profile's ticks with a plan from planApiIndex and record the link. */
function applyApiIndex(profileId, link, plan) {
  const { progress, added, removed, unmatched, unsupported } = plan;

  store.setProgress(profileId, progress);
  store.setLink(profileId, { ...link, syncedAt: new Date().toISOString() });
  // The ticks changed under it, so an older edit would no longer undo cleanly.
  state.undoStack = state.undoStack.filter((entry) => entry.profileId !== profileId);

  if (profileId === state.profileId) {
    state.progress = store.getProgress(profileId);
    state.range = null;
    renderAll();
  }
  if (unmatched.length) console.warn("API entries with no matching pet:", unmatched);
  return { added, removed, unmatched, unsupported };
}

function describeSync({ added, removed, unmatched, unsupported }) {
  const ticks = (n) => `${n.toLocaleString()} ${n === 1 ? "tick" : "ticks"}`;
  let message = added ? `Imported ${ticks(added)}.` : removed ? "" : "No new ticks imported.";
  if (removed) message += ` Removed ${ticks(removed)} not in your in-game index.`;
  message = message.trim();
  if (unmatched.length) {
    // Names come from the API squashed together ("nuclearcow"), which is still
    // enough to recognise the pet.
    const shown = unmatched.slice(0, 5).join(", ");
    const more = unmatched.length > 5 ? `, and ${unmatched.length - 5} more` : "";
    message += ` Not in the tracker yet: ${shown}${more}.`;
  }
  if (unsupported) {
    message += ` ${unsupported.toLocaleString()} ${unsupported === 1 ? "entry" : "entries"} skipped.`;
  }
  return message;
}

async function runApiConnect(form) {
  if (apiBusy) return;

  const link = { user: form.user.value.trim(), token: form.token.value.trim(), syncedAt: null };
  if (!link.user || !link.token) {
    setApiStatus(form, "Enter your Roblox username and access token.", "error");
    return;
  }

  setApiBusy(true);
  setApiStatus(form, "Importing…");
  try {
    const body = await fetchPlayerIndex(link);
    link.userId = body.userId;

    // First run creates the profile: the name the player typed, else their
    // username. Anywhere else the import goes into the active profile.
    let profile = state.profileId ? store.getProfile(state.profileId) : null;
    const created = !profile;
    if (created) {
      const typed = form.nameWrap.hidden ? "" : normalizeName(form.name.value);
      profile = store.createProfile(typed || normalizeName(body.name || link.user)).profile;
      switchProfile(profile.id);
    }

    // Never quietly point a profile at a different player: their ticks would be
    // merged into this checklist and every later refresh would add more.
    const existing = store.getLink(profile.id);
    if (existing?.userId && existing.userId !== body.userId) {
      setApiStatus(
        form,
        `"${profile.name}" is linked to a different player. Disconnect it first, or switch to another profile.`,
        "error",
      );
      return;
    }

    const plan = planApiIndex(profile.id, body);
    // Linking a profile that already has hand-made ticks replaces them, which
    // cannot be undone; say so before doing it. Refreshes of a linked profile
    // already agreed to this when it was linked.
    if (!created && !existing && plan.removed > 0) {
      const ok = confirm(
        `Importing will remove ${plan.removed.toLocaleString()} ${plan.removed === 1 ? "tick" : "ticks"} ` +
          `from "${profile.name}" that are not in your in-game index. Continue?`,
      );
      if (!ok) {
        setApiStatus(form, "Import cancelled. Nothing was changed.");
        return;
      }
    }
    if (!existing) store.setLocked(profile.id, null); // a newly linked profile starts locked
    const result = applyApiIndex(profile.id, link, plan);
    if (created) form.name.value = "";
    fillApiForms();
    setApiStatus(form, `${describeSync(result)} Profile: "${profile.name}".`, "ok");
    toast(created ? `Created "${profile.name}" from the game.` : `Imported into "${profile.name}".`);
    form.onSuccess?.();
  } catch (error) {
    setApiStatus(form, error instanceof ApiImportError ? error.message : "Something went wrong importing.", "error");
  } finally {
    setApiBusy(false);
  }
}

async function runApiRefresh({ quiet = false } = {}) {
  const profileId = state.profileId;
  const link = profileId ? store.getLink(profileId) : null;
  if (!link || apiBusy) return;

  setApiBusy(true);
  try {
    const body = await fetchPlayerIndex(link);
    // A username can be released and taken by someone else; the user ID cannot.
    if (link.userId && body.userId !== link.userId) {
      throw new ApiImportError(
        "That username now belongs to a different player. Disconnect this profile and import again.",
      );
    }
    const result = applyApiIndex(profileId, link, planApiIndex(profileId, body));
    if (!quiet) toast(describeSync(result));
    else if (result.added || result.removed) {
      toast(`Refreshed from the game. ${describeSync(result)}`);
    }
  } catch (error) {
    // A silent refresh on page load should not nag; an explicit one should.
    if (!quiet) toast(error instanceof ApiImportError ? error.message : "Could not refresh from the game.");
    else console.warn("API refresh failed:", error.message);
  } finally {
    setApiBusy(false);
  }
}

function runApiDisconnect() {
  if (!state.profileId) return;
  store.clearLink(state.profileId);
  fillApiForms();
  toast("Disconnected. Your ticks were kept.");
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function wireEvents() {
  dom.onboardShowApi.addEventListener("click", () => {
    showOnboardTab("api");
    apiForms[0].user.focus();
  });
  dom.onboardShowManual.addEventListener("click", () => {
    showOnboardTab("manual");
    dom.onboardName.focus();
  });

  dom.onboardManual.addEventListener("click", () => {
    if (!normalizeName(dom.onboardName.value)) {
      dom.onboardName.focus();
      toast("Enter a profile name first.");
      return;
    }
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

  dom.openBackup.addEventListener("click", () => openBackupDialog("api"));
  dom.tabApi.addEventListener("click", () => showBackupTab("api"));
  dom.tabExport.addEventListener("click", () => showBackupTab("export"));
  dom.tabImport.addEventListener("click", () => showBackupTab("import"));
  dom.apiRefresh.addEventListener("click", () => runApiRefresh());
  dom.apiSync.addEventListener("click", () => openBackupDialog("api"));
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

  for (const button of dom.viewButtons) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  dom.gridVariants.addEventListener("click", (event) => {
    const button = event.target.closest("[data-grid-variant]");
    if (!button) return;
    setGridVariant(button.dataset.gridVariant);
  });
  attachHoverCard(dom.grid, dom.grid.parentElement, (slug) => state.index.bySlug.get(slug));
  attachGridKeys(dom.grid);
  attachGridWindow(dom.grid, dom.grid.parentElement);
  document.addEventListener("keydown", onShortcut);
  dom.grid.addEventListener("click", (event) => {
    const tile = event.target.closest(".gv-tile");
    if (tile) onGridToggle(tile);
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

  // The Source header toggles grouping by source; clicking it again puts the order back.
  dom.thead.addEventListener("click", (event) => {
    if (!event.target.closest(".sort-btn")) return;
    state.sortBySource = !state.sortBySource;
    state.range = null; // an anchor row means nothing in a new order
    renderBody();
    // The head was rebuilt, so the button that had focus is gone.
    dom.thead.querySelector(".sort-btn")?.focus();
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

  dom.lockNoteDismiss.addEventListener("click", () => {
    saveSettings({ lockNoteDismissed: true });
    dom.lockNote.hidden = true;
  });

  dom.bulkHintDismiss.addEventListener("click", () => {
    saveSettings({ bulkHintSeen: true });
    dom.bulkHint.hidden = true;
  });

  let searchTimer = null;
  dom.filterSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = dom.filterSearch.value;
      renderBody();
    }, 120);
  });

  dom.filterReset.addEventListener("click", () => {
    // "Reset" means back to your configured default, not back to showing
    // everything — otherwise it would undo the hide-completed preference.
    const status = loadSettings().hideCompleted ? "incomplete" : "all";
    state.filters = { search: "", sources: [], rarities: [], status, missing: [] };
    renderFilters();
    renderBody();
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
  fillSizer(dom.sourceSizer, [...state.index.widest.source, FILTER_ALL.source]);
  fillSizer(dom.raritySizer, [...state.index.widest.rarity, FILTER_ALL.rarity]);
  fillSizer(dom.statusSizer, STATUS_OPTIONS.map((o) => o.label));
  fillSizer(dom.missingSizer, [...state.index.variants.map((v) => v.label), FILTER_ALL.missing, `${state.index.variants.length} variants`]);

  state.categoryId = initialCategoryId(state.index, settings);
  if (settings.hideCompleted) state.filters.status = "incomplete";
  state.profileId = store.getActiveProfileId();
  state.progress = store.getProgress(state.profileId);

  if (!store.storageAvailable) {
    toast("Local storage is blocked. Progress will not be saved.");
  }

  state.view = initialView();
  applyView();
  if (state.view === "grid") state.petImages = await loadPetImages();

  trackHeaderHeight();
  syncListHeight();
  mountApiForm(dom.onboardApiForm, { naming: true });
  mountApiForm(dom.panelApi);
  mountApiForm(dom.syncApiForm, { onSuccess: () => dom.syncDialog.close(), dismissLabel: "Not now" });
  wireEvents();
  renderProfiles();
  if (state.profileId) renderAll();
  else apiForms[0].user.focus();

  // A profile linked to the API refreshes itself on every load.
  renderApiLink();
  runApiRefresh({ quiet: true });
  registerIconCache();
  showStartupPrompts().catch((error) => console.warn("Startup prompts failed:", error));
}

/**
 * What a returning visitor is told on load, at most one popup per visit.
 *
 * The "What's new" popup goes first. The sync dialog is for a visitor who has
 * profiles but none synced with the game; it waits for a visit with no new entry
 * rather than stacking on top of one. Both stay up across refreshes until
 * they are closed. Anyone who skips the sync dialog still has the Sync from game
 * button next to the profile name.
 */
async function showStartupPrompts() {
  const profiles = store.listProfiles();
  const hasProfiles = profiles.length > 0;

  if (await maybeShowWhatsNew({ hasProfiles })) return;
  if (!hasProfiles || loadSettings().syncPromptSeen) return;
  if (profiles.some((profile) => store.getLink(profile.id))) return;

  // Seen once it is closed (x, Not now, Escape, a click outside, or a finished
  // import), not when it opens, so a refresh brings it back.
  dom.syncDialog.addEventListener("close", () => saveSettings({ syncPromptSeen: true }), { once: true });
  dom.syncDialog.showModal();
}

/**
 * Pet icons are cached for good by sw.js (GitHub Pages only allows ten minutes).
 * Registered after the page has settled so it never competes with first paint, and
 * optional: without it, or over plain http, icons load exactly as before.
 */
function registerIconCache() {
  if (!("serviceWorker" in navigator)) return;
  const register = () => navigator.serviceWorker.register("sw.js").catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

boot();
