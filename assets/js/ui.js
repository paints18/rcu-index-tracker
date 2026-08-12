/** Pure rendering helpers. These build DOM; main.js owns state and events. */

/**
 * Tag an element with the variant it represents. The stylesheet maps
 * `[data-variant="golden"]` to the right colour, so palette names live in CSS
 * only — this file previously hardcoded `var(--v-golden)`, which silently broke
 * every variant colour the moment those variables were renamed.
 */
function tagVariant(node, variantId) {
  node.dataset.variant = variantId;
  return node;
}

/**
 * Shift-click is the one gesture here with no visible affordance, so it is
 * advertised on every box it works on. The bulk bar used to explain it in a
 * standing paragraph; a tooltip on the control itself says it where and when it
 * is relevant instead, and costs no space at all.
 */
const SHIFT_HINT = "shift-click to fill every row back to your last click";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function percent(done, total) {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

/* ---------- fitting text to a fixed column ---------- */

/**
 * How far a value is allowed to shrink, as a fraction of the body type.
 *
 * A value past this is wider than its column no matter what, so the column gives
 * way instead — an unreadable name is a worse outcome than a wide column, and at
 * this point the value is so far over the cap that the cap itself is what wants
 * revisiting (see WIDTH_CAP in data.js).
 */
const MIN_FIT = 0.7;

/**
 * Which columns are set in something other than the plain body cell type, and
 * the modifier that reproduces it on their ruler. A ruler in a different type
 * from the column it is measuring for would quietly hand back the wrong number,
 * so Pet (larger and heavier) and Clicks (tabular figures, which are a different
 * width from the proportional ones) each measure in their own.
 */
const RULER_TYPE = { name: " is-name", clicks: " is-clicks" };

/** Off-screen rulers, one per column type. Built on demand, kept for the page. */
const rulers = new Map();
const measured = new Map();

/**
 * Measure a string in the exact type of the body cells it will be drawn in.
 *
 * The ruler is a real element in the real font rather than a canvas or a `ch`
 * estimate, for the same reason the column sizers are (see textHead): these are
 * proportional faces, and nothing but the browser knows what a given string
 * actually measures in one. The stylesheet gives .fit-probe the same rules as
 * the sizers, so the two cannot drift apart.
 *
 * Widths are cached forever, keyed by column and string, which is what keeps
 * this off the path of a filter keystroke: every value is measured once and
 * re-rendered from cache after that. Nothing that would change a width changes
 * while the page is open — the density setting moves row padding, not type —
 * and browser zoom scales the ruler and the value together, so the RATIO these
 * are used for survives it either way.
 */
function measure(text, column) {
  const type = RULER_TYPE[column] ?? "";
  const key = `${type}\n${text}`;
  const hit = measured.get(key);
  if (hit !== undefined) return hit;

  let ruler = rulers.get(type);
  if (!ruler) {
    ruler = el("span", `fit-probe${type}`);
    document.body.append(ruler);
    rulers.set(type, ruler);
  }

  ruler.textContent = text;
  const width = ruler.getBoundingClientRect().width;
  measured.set(key, width);
  return width;
}

/**
 * Shrink a value that is wider than the space its column reserves.
 *
 * The columns are held to a fixed width by samples that exclude outliers, so a
 * value longer than every sample would otherwise push its column wider — in
 * every category, not just the one the long pet is in, since the samples are
 * dataset-wide. Scaling the type down instead keeps the value fully readable and
 * the column exactly where it was.
 *
 * The scale is measured against the very samples that set the width, so a fitted
 * value lands at the column's own width by construction; it does not depend on
 * the viewport, the density setting, or how much slack the table happens to have.
 * Rounded down, since text width tracks font size closely but not exactly, and
 * the rounding has to fall on the safe side of the column edge.
 *
 * @param {string} text The value about to be drawn.
 * @param {string[]} samples The column's width samples (see widestValues).
 * @param {string} column Which column it is being drawn in.
 * @returns {number|null} A font size as a fraction of the body type, or null if
 *   the value already fits and should be left alone.
 */
function fitScale(text, samples, column) {
  if (!text || !samples?.length) return null;

  const room = Math.max(...samples.map((sample) => measure(sample, column)));
  const needed = measure(text, column);
  if (!room || needed <= room) return null;

  return Math.max(MIN_FIT, Math.floor((room / needed) * 100) / 100);
}

/**
 * A body cell whose text is shrunk rather than allowed to widen its column.
 *
 * The scale goes on a span inside the cell, not on the cell itself: `em` there
 * resolves against the column's own type, so one number works for the Pet column
 * and the smaller three alike, and the cell keeps its padding at full size. The
 * span carries no styling of its own — .fit is a marker, there to make a shrunk
 * value obvious in the inspector, and the size is inline because it is a
 * different number for every value.
 */
function textCell(column, value, samples) {
  const cell = el("td", `col-${column}`);
  const scale = fitScale(value, samples, column);

  if (scale == null) {
    cell.textContent = value;
  } else {
    const fitted = el("span", "fit", value);
    fitted.style.fontSize = `${scale}em`;
    cell.append(fitted);
  }
  return cell;
}

/* ---------- category nav ---------- */

export function renderCategoryNav(index, perCategory, activeId) {
  const fragment = document.createDocumentFragment();

  for (const cat of index.categories) {
    const button = el("button", "cat-pill");
    button.type = "button";
    button.dataset.categoryId = cat.id;
    button.append(cat.label);

    if (cat.totalTicks === 0) {
      // Categories with no pets yet (event eggs awaiting data) stay visible but
      // muted, so it is obvious they exist and are simply not filled in.
      button.classList.add("is-empty");
      button.append(el("span", "pill-count", "pending"));
    } else {
      const done = perCategory.get(cat.id) ?? 0;
      button.append(el("span", "pill-count", `${done}/${cat.totalTicks}`));
    }

    if (cat.id === activeId) {
      button.classList.add("is-active");
      button.setAttribute("aria-current", "true");
    }
    fragment.append(button);
  }
  return fragment;
}

/* ---------- summary ---------- */

export function renderVariantSummary(variants, doneByVariant, totalByVariant) {
  const fragment = document.createDocumentFragment();

  for (const variant of variants) {
    const total = totalByVariant.get(variant.id) ?? 0;
    const done = doneByVariant.get(variant.id) ?? 0;

    const item = tagVariant(el("li"), variant.id);
    item.append(el("div", "vs-label", variant.label));
    item.append(el("div", "vs-value", `${done} / ${total}`));
    fragment.append(item);
  }
  return fragment;
}

/* ---------- table ---------- */

/**
 * @typedef {object} HeadCounts Everything the head says, measured over the rows
 *   currently on screen — which is also exactly what its checkboxes act on.
 * @property {Map<string, number>} done Boxes caught, per variant.
 * @property {Map<string, number>} total Boxes that exist, per variant.
 * @property {number} full Pets with every variant they have caught.
 * @property {number} pets How many pets are in scope.
 */

/**
 * The string every column's count is sized to hold, drawn once and hidden.
 *
 * Read it as a width, not as a number — the two halves are different lengths
 * because the total is the only thing that has to fit and the rest is chosen for
 * looks. This string IS the width of a tick column, and it is deliberately wider
 * than any count can be: nine digits is orders of magnitude past what the data
 * can reach (the whole index is 2,498 boxes, and one column of one category is a
 * fraction of that), so no count can outgrow it and start resizing its column
 * again. The slack left over is the point rather than a side effect — it is what
 * the label sits in, and the reason it is not crammed against the checkbox.
 * Give or take a digit is a spacing decision, not a correctness one.
 *
 * Fixed rather than each column's own widest value, so every tick column
 * reserves the same width and they stay uniform with each other.
 */
const COUNT_WIDTH = "0000/00000";

/**
 * Build a header cell that doubles as a bulk control.
 *
 * The checkbox lives in the column it acts on, so nothing has to explain the
 * mapping — this is the select-all-in-a-table idiom, and the count beside it is
 * the same number the click will move.
 *
 * It sits to the LEFT of the name/count stack rather than above it: stacked, it
 * cost a whole extra line of header height for a 17px control. The stylesheet
 * reserves the same width again on the right so the label stays on the column's
 * centre line — the line the row ticks below it sit on (see .vhead). That space
 * is reserved whether or not bulk edit is on, so turning the mode on never
 * pushes the table around.
 *
 * @param {string} columnId A variant id, or "*" for the roll-up column.
 */
function headCell(className, columnId, label, variantId) {
  const cell = el("th", className);
  cell.scope = "col";

  const wrap = el("span", "vhead");
  if (variantId) tagVariant(wrap, variantId);

  const tick = el("label", `tick vhead-tick${variantId ? "" : " tick-all"}`);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.bulkColumn = columnId;
  tick.append(input);

  const text = el("span", "vhead-text");
  text.append(el("span", "vhead-name", label));

  // Two counts stacked in one grid cell: an invisible four-digit pair that holds
  // the width open and the live one drawn over it. See setCount.
  const count = el("span", "vhead-count");
  count.append(el("span", "vhead-count-max", COUNT_WIDTH));
  count.append(el("span", "vhead-count-now"));
  text.append(count);

  wrap.append(tick);
  wrap.append(text);
  cell.append(wrap);
  return cell;
}

/**
 * A plain text column's header, carrying the width of the whole dataset.
 *
 * The label and every width sample land in one grid cell, stacked on top of each
 * other: the column ends up as wide as the widest of them and no taller than the
 * label, because the samples are drawn at zero height. Without this a column is
 * only as wide as the category it is showing, so switching worlds shifted every
 * column beside it — the pet names in World 1 are nothing like the pet names in
 * World 12.
 *
 * The samples are hidden with `visibility`, not skipped, precisely because
 * hidden content still takes up space. They must be measured in the body's type,
 * not the header's, since it is the body cells they are standing in for — hence
 * .col-sizer's own font rules.
 *
 * @param {string[]} samples Candidates for the widest value (see widestValues).
 */
function textHead(className, label, samples = []) {
  const cell = el("th", className);
  cell.scope = "col";

  const stack = el("span", "head-stack");
  stack.append(el("span", null, label));
  for (const sample of samples) stack.append(el("span", "col-sizer", sample));

  cell.append(stack);
  return cell;
}

export function renderTableHead(variants, category, counts, widest = {}) {
  const row = el("tr");
  row.append(textHead("col-name", "Pet", widest.name));
  row.append(textHead("col-egg", "Egg", widest.egg));
  row.append(textHead("col-rarity", "Rarity", widest.rarity));
  row.append(textHead("col-clicks", "Clicks", widest.clicks));

  // Only show variant columns that at least one pet in this category has. Note
  // this is the CATEGORY, not the filtered scope: columns appearing and
  // vanishing as you type in the search box would be far more disorienting than
  // a column that is briefly empty.
  const used = usedVariants(variants, category);

  // The roll-up column comes first of the tick columns — on a narrow viewport
  // the table scrolls sideways, and a far-right control would be off screen.
  row.append(headCell("col-all", "*", "All", null));
  for (const variant of used) {
    row.append(headCell("col-variant", variant.id, variant.label, variant.id));
  }

  const head = document.createDocumentFragment();
  head.append(row);
  syncTableHead(row, used, counts);
  return { head, used };
}

/**
 * Bring an already-rendered head in line with the current scope.
 *
 * Updated in place rather than rebuilt for the same reason rows are (see
 * syncRow), plus one of its own: replacing the head would destroy the very
 * checkbox the user just clicked, losing keyboard focus mid-way through the
 * common "Normal, then Golden, then Toxic" run.
 *
 * Each checkbox reads its own column's counts, so the tri-state needs no extra
 * bookkeeping: full column checked, partial column mixed, empty column clear.
 * A column with nothing in scope is disabled — there is nothing for it to do.
 */
export function syncTableHead(headRow, used, counts) {
  const setBox = (input, done, total) => {
    if (!input) return;
    input.checked = total > 0 && done === total;
    input.indeterminate = done > 0 && done < total;
    input.disabled = total === 0;
  };
  const cellFor = (columnId) =>
    headRow.querySelector(`input[data-bulk-column="${columnId}"]`)?.closest(".vhead");

  /**
   * Write a count that cannot resize its own column.
   *
   * "0/138" is narrower than "138/138", and these columns are sized by their
   * content, so a count left to its own width dragged the whole table sideways
   * as you filled a column — the one thing a bulk click must not do, since the
   * next click in the run is aimed at the header you are already pointing at.
   *
   * Only the live half is written here. The width is held open by COUNT_WIDTH,
   * hidden in the same grid cell and already in place, which measures the space
   * in the real font — `ch` units could not, since the slash is not a digit.
   */
  const setCount = (wrap, done, total) => {
    wrap.querySelector(".vhead-count-now").textContent = `${done}/${total}`;
  };

  // Both the label and the tooltip name the scope out loud, because "shown" is
  // the one thing the layout cannot say on its own once a filter narrows the
  // table — and the verb tells you which way this click will go.
  const describe = (input, what, done, total) => {
    const verb = total > 0 && done === total ? "Clear" : "Mark";
    input.setAttribute("aria-label", `${verb} ${what}`);
    input.title = total === 0 ? `Nothing shown in this column` : `${verb} ${what}`;
  };

  const allWrap = cellFor("*");
  if (allWrap) {
    setCount(allWrap, counts.full, counts.pets);
    const input = allWrap.querySelector("input");
    setBox(input, counts.full, counts.pets);
    describe(input, `every variant of all ${counts.pets} pets shown`, counts.full, counts.pets);
  }

  for (const variant of used) {
    const wrap = cellFor(variant.id);
    if (!wrap) continue;
    const done = counts.done.get(variant.id) ?? 0;
    const total = counts.total.get(variant.id) ?? 0;
    setCount(wrap, done, total);
    const input = wrap.querySelector("input");
    setBox(input, done, total);
    describe(input, `all ${total} ${variant.label} boxes shown`, done, total);
  }
}

export function usedVariants(variants, category) {
  const present = new Set();
  for (const pet of category.pets) {
    for (const variantId of pet.variants) present.add(variantId);
  }
  return variants.filter((v) => present.has(v.id));
}

/**
 * @param {object} [widest] The per-column width samples (see widestValues). The
 *   rows are measured against the same samples the head is sized by, so a value
 *   too long for its column shrinks instead of widening it.
 */
export function renderRows(pets, progress, usedVariantList, widest = {}) {
  const fragment = document.createDocumentFragment();

  for (const pet of pets) {
    const caught = new Set(progress[pet.slug] ?? []);
    const row = el("tr");
    row.dataset.slug = pet.slug;

    row.append(textCell("name", pet.name, widest.name));
    row.append(textCell("egg", pet.egg && pet.egg !== "-" ? pet.egg : "—", widest.egg));
    row.append(textCell("rarity", pet.rarity ?? "—", widest.rarity));
    row.append(textCell("clicks", pet.clicks ?? "—", widest.clicks));

    // The roll-up box: one click for every variant this pet actually has.
    // Deliberately carries no data-variant — that absence is what marks it as
    // the roll-up, both for the stylesheet and for the click handler in main.js.
    const allCell = el("td", "col-all");
    const allLabel = el("label", "tick tick-all");
    const allInput = document.createElement("input");
    allInput.type = "checkbox";
    allInput.dataset.slug = pet.slug;
    allInput.setAttribute("aria-label", `Every variant of ${pet.name}`);
    allInput.title = `Every variant of ${pet.name} — ${SHIFT_HINT}`;
    allLabel.append(allInput);
    allCell.append(allLabel);
    row.append(allCell);

    for (const variant of usedVariantList) {
      const cell = el("td", "col-variant");

      // A cell is left empty when the variant does not exist for this pet, which
      // is different from an unchecked box ("exists but not caught").
      if (pet.variants.includes(variant.id)) {
        const label = tagVariant(el("label", "tick"), variant.id);

        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.slug = pet.slug;
        input.dataset.variant = variant.id;
        input.setAttribute("aria-label", `${variant.label} ${pet.name}`);
        input.title = `${variant.label} ${pet.name} — ${SHIFT_HINT}`;

        label.append(input);
        cell.append(label);
      }
      row.append(cell);
    }

    // One code path decides what a row looks like, at build time and after every
    // in-place edit, so the two can never drift apart.
    syncRow(row, pet, caught);
    fragment.append(row);
  }
  return fragment;
}

/**
 * Bring an already-rendered row in line with progress: the variant boxes, the
 * roll-up (including its mixed state), and the completion tint.
 *
 * This is what lets a range fill touch two hundred rows without rebuilding the
 * table under the pointer. It re-asserts every box from stored progress rather
 * than trusting the click that caused it, so a write that fell back to memory on
 * a quota error still leaves the checkbox showing the truth.
 *
 * @param {HTMLTableRowElement} row
 * @param {object} pet
 * @param {Set<string>} caught Variant ids caught for this pet.
 */
export function syncRow(row, pet, caught) {
  const owned = pet.variants.filter((v) => caught.has(v)).length;
  const complete = pet.variants.length > 0 && owned === pet.variants.length;

  for (const input of row.querySelectorAll("input[data-slug]")) {
    if (input.dataset.variant) {
      input.checked = caught.has(input.dataset.variant);
    } else {
      // `indeterminate` is a property, never an attribute, and deliberately not
      // aria-checked="mixed" — that conflicts with a native checkbox's implicit
      // state and screen readers announce the mix from the property already.
      input.checked = complete;
      input.indeterminate = owned > 0 && !complete;
    }
  }
  row.classList.toggle("is-complete", complete);
}

/* ---------- selects ---------- */

/**
 * Hold a menu's width open with the longest values in the whole dataset.
 *
 * These menus are refilled from the category on screen, so their natural width
 * is a different number in every world and the filter row shuffles as you switch
 * between them. Written once, from data that does not change while the page is
 * open — the widest samples, plus whatever placeholder sits above them.
 *
 * @param {HTMLElement} sizer
 * @param {string[]} samples
 */
export function fillSizer(sizer, samples = []) {
  if (!sizer) return;
  sizer.replaceChildren(...samples.map((sample) => el("span", null, sample)));
}

export function fillSelect(select, options, { placeholder, value } = {}) {
  select.replaceChildren();

  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.append(opt);
  }

  for (const option of options) {
    const opt = document.createElement("option");
    if (typeof option === "string") {
      opt.value = option;
      opt.textContent = option;
    } else {
      opt.value = option.value;
      opt.textContent = option.label;
    }
    select.append(opt);
  }

  if (value != null) select.value = value;
}
