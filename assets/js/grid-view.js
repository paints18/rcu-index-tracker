/**
 * Grid view: the in-game index layout as an alternative to the checklist table.
 *
 * Pure rendering. State and persistence stay in main.js; this module builds
 * tiles from a pet list and a progress object and exposes syncTile so a click
 * can update one tile in place instead of rebuilding the grid.
 *
 * Icons come from data/pet-images.json (slug -> one asset id per variant, in
 * VARIANT_ORDER) and live at assets/pets/<id>.png. Regenerate both with
 * tools/fetch_pet_images.py. A pet with no image for a variant gets a text tile.
 */

const IMAGES_URL = "data/pet-images.json";
const IMAGE_DIR = "assets/pets";

/** The order of the ids in each pet-images.json entry. */
const VARIANT_ORDER = ["normal", "golden", "toxic", "galaxy"];

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
  return id ? `${IMAGE_DIR}/${id}.png` : null;
}

function tileLabel(pet, variant, caught) {
  return `${pet.name} — ${variant.label}, ${caught ? "indexed" : "not indexed"}`;
}

function buildTile(pet, variant, images, caught) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "gv-tile";
  tile.tabIndex = -1; // one tile at a time is a Tab stop; see attachGridKeys
  tile.dataset.slug = pet.slug;
  tile.dataset.variant = variant.id;
  tile.dataset.rarity = (pet.rarity ?? "").toLowerCase();
  tile.dataset.name = pet.name;

  const src = imageUrl(images, pet.slug, variant.id);
  if (src) {
    const img = new Image();
    img.src = src;
    img.alt = "";
    img.draggable = false;
    img.loading = "lazy";
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

/**
 * @param {HTMLElement} host The grid container.
 * @param {object[]} pets Already filtered; pets without this variant are skipped here.
 * @param {Record<string, string[]>} progress slug -> caught variant ids
 * @param {{id: string, label: string}} variant
 * @param {Record<string, string[]>} images
 * @returns {{ done: number, total: number }} Counts over the pets shown.
 */
export function renderGrid(host, pets, progress, variant, images) {
  const fragment = document.createDocumentFragment();
  let done = 0;
  let total = 0;

  for (const pet of pets) {
    if (!pet.variants.includes(variant.id)) continue;
    const caught = (progress[pet.slug] ?? []).includes(variant.id);
    total += 1;
    if (caught) done += 1;
    const tile = buildTile(pet, variant, images, caught);
    tile.dataset.variantLabel = variant.label;
    fragment.append(tile);
  }

  host.replaceChildren(fragment);
  if (host.firstElementChild) host.firstElementChild.tabIndex = 0;
  return { done, total };
}

/* ---------- keyboard ---------- */

/** How many tiles share the first row; the grid's column count at the current width. */
function columnCount(tiles) {
  const top = tiles[0].offsetTop;
  let n = 1;
  while (n < tiles.length && tiles[n].offsetTop === top) n += 1;
  return n;
}

/**
 * Arrow-key movement across the tiles, and a single Tab stop for the whole grid.
 *
 * Without the roving tabindex every tile is its own Tab stop, so getting past a
 * category means tabbing through hundreds of buttons. Here Tab enters the grid
 * on the tile that last had focus (the first one after a re-render) and the next
 * Tab leaves it. Space and Enter already tick a focused tile, being buttons.
 *
 * Movement stops at the edges rather than wrapping, as in the list view.
 *
 * @param {HTMLElement} host The grid container.
 * @param {HTMLElement} scroller The grid's scroll window, for the Page Up/Down distance.
 */
export function attachGridKeys(host, scroller) {
  let stop = null;

  host.addEventListener("focusin", (event) => {
    const tile = event.target.closest?.(".gv-tile");
    if (!tile) return;
    if (stop && stop !== tile) stop.tabIndex = -1;
    tile.tabIndex = 0;
    stop = tile;
  });

  host.addEventListener("keydown", (event) => {
    const tile = event.target.closest?.(".gv-tile");
    if (!tile || event.altKey || event.metaKey) return;

    const tiles = [...host.children];
    const at = tiles.indexOf(tile);
    const cols = columnCount(tiles);
    const last = tiles.length - 1;
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
        const step = tiles[cols] ? tiles[cols].offsetTop - tiles[0].offsetTop : tile.offsetHeight;
        const rows = Math.max(1, Math.floor(scroller.clientHeight / Math.max(step, 1)));
        const jump = rows * cols;
        next = event.key === "PageUp" ? Math.max(at - jump, at % cols) : Math.min(at + jump, last);
        break;
      }
      default:
        return;
    }

    event.preventDefault(); // these keys would otherwise scroll the page
    if (next !== at) tiles[next].focus();
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
  // A re-render replaces the tiles out from under the pointer.
  new MutationObserver(hide).observe(host, { childList: true });
}
