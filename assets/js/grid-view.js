/**
 * Grid view: the in-game index layout as an alternative to the checklist table.
 *
 * Rendering only. State and persistence stay in main.js; this module builds tiles
 * from a pet list and a progress object and exposes syncTile so a click can
 * update one tile in place instead of rebuilding the grid.
 *
 * Only the rows near the scroll position exist in the page. The "All" category is
 * well over a thousand pets, and a thousand image elements (each with a CSS filter
 * for the silhouette) is what makes scrolling it crawl. The rest of the height is
 * padding on the grid, so the scrollbar still spans the whole list, and tiles are
 * added and removed as it scrolls.
 *
 * Icons come from data/pet-images.json (slug -> one asset id per variant, in
 * VARIANT_ORDER) and live at assets/pets/<id>.webp. Regenerate both with
 * tools/fetch_pet_images.py. A pet with no image for a variant gets a text tile.
 */

const IMAGES_URL = "data/pet-images.json";
const IMAGE_DIR = "assets/pets";

/** The order of the ids in each pet-images.json entry. */
const VARIANT_ORDER = ["normal", "golden", "toxic", "galaxy"];

/** Rows kept above and below the visible window, so scrolling never shows a blank. */
const BUFFER_ROWS = 3;

/** Used while the grid is hidden and cannot be measured; corrected once it is shown. */
const FALLBACK = { cols: 7, rowStep: 80, viewRows: 8 };

let imagesPromise = null;

/** Fetched once, on first use. Resolves to {} if the file is missing, so the grid still works. */
export function loadPetImages() {
  imagesPromise ??= fetch(IMAGES_URL, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return imagesPromise;
}

function imageUrl(images, slug, variantId) {
  const id = images[slug]?.[VARIANT_ORDER.indexOf(variantId)];
  return id ? `${IMAGE_DIR}/${id}.webp` : null;
}

function tileLabel(pet, variant, caught) {
  return `${pet.name} — ${variant.label}, ${caught ? "indexed" : "not indexed"}`;
}

/** The one grid on the page, as last drawn by renderGrid. */
const grid = {
  host: null,
  scroller: null,
  /** Pets that have the chosen variant, in display order. */
  items: [],
  /** slug -> position in items. */
  position: new Map(),
  variant: null,
  images: {},
  getProgress: () => ({}),
  cols: FALLBACK.cols,
  /** Height of one row including the gap below it. */
  rowStep: FALLBACK.rowStep,
  /** Rendered range of items: [from, to). */
  from: 0,
  to: 0,
  /** Item index that holds the grid's Tab stop. */
  stop: 0,
};

function buildTile(position) {
  const { variant, images } = grid;
  const pet = grid.items[position];
  const caught = (grid.getProgress()[pet.slug] ?? []).includes(variant.id);

  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "gv-tile";
  tile.tabIndex = position === grid.stop ? 0 : -1; // one tile at a time is a Tab stop
  tile.dataset.position = String(position);
  tile.dataset.slug = pet.slug;
  tile.dataset.variant = variant.id;
  tile.dataset.variantLabel = variant.label;
  tile.dataset.rarity = (pet.rarity ?? "").toLowerCase();
  tile.dataset.name = pet.name;
  // Tiles made while scrolling must match the lock too; main.js only sees existing ones.
  tile.setAttribute("aria-disabled", String(document.documentElement.hasAttribute("data-ticks-locked")));

  const src = imageUrl(images, pet.slug, variant.id);
  if (src) {
    const img = new Image();
    img.src = src;
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    tile.append(img);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "gv-fallback";
    fallback.textContent = pet.name;
    tile.append(fallback);
  }

  syncTile(tile, caught, pet, variant);
  return tile;
}

/** Put one tile in line with whether the pet is indexed. */
export function syncTile(tile, caught, pet, variant) {
  tile.classList.toggle("is-caught", caught);
  tile.setAttribute("aria-pressed", String(caught));
  const label = tileLabel(
    pet ?? { name: tile.dataset.name },
    variant ?? { label: tile.dataset.variantLabel },
    caught,
  );
  tile.setAttribute("aria-label", label);
}

/** Take a tile out; an icon still loading is told to stop, so scrolling fast does not queue them up. */
function removeTile(tile) {
  const img = tile.firstElementChild;
  if (img?.tagName === "IMG" && !img.complete) img.removeAttribute("src");
  tile.remove();
}

/** Column count and row height from the grid's real width, or the fallback while hidden. */
function measure() {
  const { host } = grid;
  const width = host.getBoundingClientRect().width;
  if (!width) {
    grid.cols = FALLBACK.cols;
    grid.rowStep = FALLBACK.rowStep;
    return;
  }
  const style = getComputedStyle(host);
  const cols = style.gridTemplateColumns.split(" ").filter(Boolean).length || FALLBACK.cols;
  const gap = parseFloat(style.columnGap) || 0;
  grid.cols = cols;
  // Tiles are square, so a row is as tall as a column is wide.
  grid.rowStep = (width - (cols - 1) * gap) / cols + gap;
}

function windowRows() {
  const { scroller, cols, rowStep, items } = grid;
  const totalRows = Math.ceil(items.length / cols);
  const viewHeight = scroller.clientHeight || rowStep * FALLBACK.viewRows;
  const first = Math.max(0, Math.floor(scroller.scrollTop / rowStep) - BUFFER_ROWS);
  const last = Math.min(totalRows - 1, Math.ceil((scroller.scrollTop + viewHeight) / rowStep) + BUFFER_ROWS);
  return { totalRows, first, last };
}

/** Make sure exactly one rendered tile can be reached with Tab. */
function ensureTabStop() {
  const { host } = grid;
  if (host.querySelector('.gv-tile[tabindex="0"]')) return;
  const tiles = [...host.children];
  if (!tiles.length) return;
  // The stop scrolled out of the window: use the first tile that is on screen instead.
  const onScreen = Math.ceil(grid.scroller.scrollTop / grid.rowStep) * grid.cols;
  const target = tiles.find((t) => Number(t.dataset.position) >= onScreen) ?? tiles[0];
  target.tabIndex = 0;
}

/**
 * Bring the rendered tiles in line with the scroll position. Cheap when nothing
 * moved a whole row, so it can run on every scroll event.
 *
 * @param {boolean} force Rebuild every tile instead of keeping the ones in range.
 */
function renderWindow(force = false) {
  const { host, items, cols, rowStep } = grid;
  if (!items.length) return;

  const { totalRows, first, last } = windowRows();
  const from = first * cols;
  const to = Math.min(items.length, (last + 1) * cols);
  if (!force && from === grid.from && to === grid.to && host.firstElementChild) return;

  host.style.paddingTop = `${first * rowStep}px`;
  host.style.paddingBottom = `${(totalRows - 1 - last) * rowStep}px`;

  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => buildTile(a + i));
  const kept = [];
  for (const tile of [...host.children]) {
    const position = Number(tile.dataset.position);
    if (!force && position >= from && position < to) kept.push(tile);
    else removeTile(tile);
  }

  if (!kept.length) {
    host.replaceChildren(...range(from, to));
  } else {
    // Added at either end rather than rebuilt, so a focused tile keeps its focus.
    host.prepend(...range(from, Number(kept[0].dataset.position)));
    host.append(...range(Number(kept.at(-1).dataset.position) + 1, to));
  }
  grid.from = from;
  grid.to = to;
  ensureTabStop();
}

/**
 * @param {HTMLElement} host The grid container.
 * @param {object[]} pets Already filtered; pets without this variant are skipped here.
 * @param {() => Record<string, string[]>} getProgress slug -> caught variant ids. A
 *   function, because tiles are made as you scroll and progress is replaced on each edit.
 * @param {{id: string, label: string}} variant
 * @param {Record<string, string[]>} images
 * @returns {{ done: number, total: number }} Counts over the pets shown.
 */
export function renderGrid(host, pets, getProgress, variant, images) {
  grid.host = host;
  grid.scroller = host.parentElement;
  grid.variant = variant;
  grid.images = images;
  grid.getProgress = getProgress;
  grid.items = pets.filter((pet) => pet.variants.includes(variant.id));
  grid.position = new Map(grid.items.map((pet, i) => [pet.slug, i]));
  grid.stop = 0;
  grid.from = 0;
  grid.to = 0;

  grid.scroller.scrollTop = 0; // a new category, variant or filter starts at the top
  host.replaceChildren();
  host.style.paddingTop = "";
  host.style.paddingBottom = "";
  measure();
  renderWindow(true);
  return countGrid();
}

/** Empty the grid, for a category with no pets. */
export function clearGrid(host) {
  grid.items = [];
  grid.position = new Map();
  grid.from = 0;
  grid.to = 0;
  host.replaceChildren();
  host.style.paddingTop = "";
  host.style.paddingBottom = "";
}

/** Caught and total over every pet in the grid, rendered or not. */
export function countGrid() {
  const progress = grid.getProgress();
  let done = 0;
  for (const pet of grid.items) {
    if ((progress[pet.slug] ?? []).includes(grid.variant.id)) done += 1;
  }
  return { done, total: grid.items.length };
}

/** Scroll a pet into view, draw its tile and focus it. No-op for a pet not in the grid. */
export function focusGridPet(slug) {
  const position = grid.position.get(slug);
  if (position != null) focusPosition(position);
}

/** Scroll just far enough to show a row, draw the window around it, and focus the tile. */
function focusPosition(position) {
  const { scroller, cols, rowStep } = grid;
  const gap = parseFloat(getComputedStyle(grid.host).rowGap) || 0;
  const rowTop = Math.floor(position / cols) * rowStep;
  const rowBottom = rowTop + rowStep - gap;
  if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
  else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = rowBottom - scroller.clientHeight;
  }
  renderWindow(); // the scroll event arrives later; the tile is needed now
  grid.host.querySelector(`.gv-tile[data-position="${position}"]`)?.focus({ preventScroll: true });
}

/**
 * Keep the rendered tiles following the scroll position and the grid's width.
 *
 * @param {HTMLElement} host The grid container.
 * @param {HTMLElement} scroller The grid's scroll window.
 */
export function attachGridWindow(host, scroller) {
  scroller.addEventListener("scroll", () => renderWindow(), { passive: true });

  if (typeof ResizeObserver !== "function") return;
  new ResizeObserver(() => {
    if (!grid.items.length || grid.host !== host) return;
    const before = `${grid.cols}/${grid.rowStep}`;
    measure();
    renderWindow(before !== `${grid.cols}/${grid.rowStep}`);
  }).observe(scroller);
}

/* ---------- keyboard ---------- */

/**
 * Arrow-key movement across the tiles, and a single Tab stop for the whole grid.
 *
 * Without the roving tabindex every tile is its own Tab stop, so getting past a
 * category means tabbing through hundreds of buttons. Here Tab enters the grid
 * on the tile that last had focus (the first one after a re-render) and the next
 * Tab leaves it. Space and Enter already tick a focused tile, being buttons.
 *
 * Movement works on the whole list, not just the tiles that exist, and scrolls to
 * wherever it lands. It stops at the edges rather than wrapping, as in the list view.
 *
 * @param {HTMLElement} host The grid container.
 */
export function attachGridKeys(host) {
  host.addEventListener("focusin", (event) => {
    const tile = event.target.closest?.(".gv-tile");
    if (!tile) return;
    host.querySelector('.gv-tile[tabindex="0"]')?.setAttribute("tabindex", "-1");
    tile.tabIndex = 0;
    grid.stop = Number(tile.dataset.position);
  });

  host.addEventListener("keydown", (event) => {
    const tile = event.target.closest?.(".gv-tile");
    if (!tile || event.altKey || event.metaKey) return;

    const at = Number(tile.dataset.position);
    const { cols, rowStep, scroller } = grid;
    const last = grid.items.length - 1;
    const rowStart = at - (at % cols);
    let next = at;

    switch (event.key) {
      case "ArrowLeft":
        next = Math.max(at - 1, 0);
        break;
      case "ArrowRight":
        next = Math.min(at + 1, last);
        break;
      case "ArrowUp":
        next = at - cols >= 0 ? at - cols : at;
        break;
      case "ArrowDown":
        // From a short last row there may be no tile directly below; land on the
        // last one instead of doing nothing, unless this already is the last row.
        next = at + cols <= last ? at + cols : at < last - (last % cols) ? last : at;
        break;
      case "Home":
        next = event.ctrlKey ? 0 : rowStart;
        break;
      case "End":
        next = event.ctrlKey ? last : Math.min(rowStart + cols - 1, last);
        break;
      case "PageUp":
      case "PageDown": {
        const rows = Math.max(1, Math.floor(scroller.clientHeight / Math.max(rowStep, 1)));
        const jump = rows * cols;
        next = event.key === "PageUp" ? Math.max(at - jump, at % cols) : Math.min(at + jump, last);
        break;
      }
      default:
        return;
    }

    event.preventDefault(); // these keys would otherwise scroll the page
    if (next !== at) focusPosition(next);
  });
}

/* ---------- hover card ---------- */

const ICON_CLICK =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 3l14 8-6.2 1.6L10 19z" fill="#5aa9f0" stroke="#1d5fa8" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ICON_EGG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.5c-3.6 0-6.5 5.4-6.5 10.2A6.5 6.5 0 0 0 12 19.2a6.5 6.5 0 0 0 6.5-6.5C18.5 7.9 15.6 2.5 12 2.5z" fill="#e7c98e" stroke="#8a6a2f" stroke-width="1.5"/></svg>';

/** "150" and "1.5K" read as a multiplier; a percentage is shown as it is. */
function clicksText(clicks) {
  if (clicks == null || clicks === "") return null;
  return String(clicks).endsWith("%") ? `${clicks} Clicks` : `x${clicks} Clicks`;
}

function row(icon, text) {
  const line = document.createElement("div");
  line.className = "gv-tip-row";
  line.innerHTML = icon;
  const label = document.createElement("span");
  label.textContent = text;
  line.append(label);
  return line;
}

/**
 * A card that follows the tile under the pointer or keyboard focus: name, rarity,
 * clicks and egg, as in the game. One element, reused for every tile.
 *
 * @param {HTMLElement} host The grid container (listeners are delegated to it).
 * @param {HTMLElement} scroller The grid's scroll window, so scrolling hides the card.
 * @param {(slug: string) => object | undefined} lookup slug -> pet
 */
export function attachHoverCard(host, scroller, lookup) {
  const card = document.createElement("div");
  card.className = "gv-tip";
  card.setAttribute("aria-hidden", "true"); // the tile's aria-label already says what it is
  card.hidden = true;
  document.body.append(card);

  let current = null;

  function hide() {
    current = null;
    card.hidden = true;
  }

  function place(tile) {
    const gap = 8;
    const t = tile.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    let top = t.top - c.height - gap;
    if (top < 4) top = t.bottom + gap; // no room above: go below
    const left = Math.min(Math.max(4, t.left + t.width / 2 - c.width / 2), innerWidth - c.width - 4);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function show(tile) {
    if (tile === current) return;
    const pet = lookup(tile.dataset.slug);
    if (!pet) return hide();
    current = tile;

    const name = document.createElement("div");
    name.className = "gv-tip-name";
    name.textContent = pet.name;

    const rarity = document.createElement("div");
    rarity.className = "gv-tip-rarity";
    rarity.textContent = pet.rarity ?? "";
    rarity.style.setProperty("--rc", getComputedStyle(tile).getPropertyValue("--rc"));

    const parts = [name, rarity];
    const clicks = clicksText(pet.clicks);
    if (clicks) parts.push(Object.assign(document.createElement("hr"), { className: "gv-tip-rule" }), row(ICON_CLICK, clicks));
    if (pet.egg && pet.egg !== "-") {
      parts.push(Object.assign(document.createElement("hr"), { className: "gv-tip-rule" }), row(ICON_EGG, pet.egg));
    }

    card.replaceChildren(...parts);
    card.hidden = false;
    place(tile);
  }

  const tileOf = (event) => event.target.closest?.(".gv-tile") ?? null;

  host.addEventListener("mouseover", (event) => {
    const tile = tileOf(event);
    if (tile) show(tile);
  });
  host.addEventListener("mouseout", (event) => {
    const tile = tileOf(event);
    // Moving between a tile and its own icon is not leaving it.
    if (tile && event.relatedTarget?.closest?.(".gv-tile") !== tile) hide();
  });
  host.addEventListener("focusin", (event) => {
    const tile = tileOf(event);
    if (tile) show(tile);
  });
  host.addEventListener("focusout", hide);
  // Scrolling hides the card, except for a keyboard-focused tile: focusing one
  // scrolls it into view, and that scroll event arrives after the card is shown.
  const onScroll = () => {
    if (current?.matches(":focus-visible")) place(current);
    else hide();
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", hide);
  // Scrolling adds and removes tiles; the card only has to go if its own tile did.
  new MutationObserver(() => {
    if (current && !current.isConnected) hide();
  }).observe(host, { childList: true });
}
