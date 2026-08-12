/**
 * The changelog, in a dialog.
 *
 * Entries are sorted by date at render time, so the order they sit in the JSON
 * file does not matter — same principle as the pet list.
 *
 * This was updates.html plus updates.js. The page was six lines of shell around
 * a list this module already built in JS, so the shell moved in here and the
 * page became a redirect. data/updates.json is fetched on first open and kept:
 * a changelog does not change while you are reading it.
 */

import { createDialog, showDialog, mountTrigger } from "./modal.js";

const UPDATES_URL = new URL("../../data/updates.json", import.meta.url);

/** Old updates.html bookmarks land on the tracker with ?updates — see updates.html. */
const OPEN_PARAM = "updates";

const KNOWN_TAGS = new Set(["added", "changed", "fixed"]);

/** Loading, empty and error all land in one line. `empty:hidden` keeps it from
 *  leaving a gap once there is nothing left to say. */
const STATUS = "py-6 text-center empty:hidden";

let ui = null;
let loaded = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "2026-08-11" -> "11 August 2026", falling back to the raw string. */
function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return value ?? "";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function renderEntry(entry, isLatest) {
  const article = el("article", `update-entry${isLatest ? " is-latest" : ""}`);

  const head = el("div", "flex flex-wrap items-baseline gap-x-3 gap-y-1.5");
  head.append(el("h3", "text-[17px] font-semibold", entry.title ?? "Untitled update"));

  const time = el("time", "text-[13px] text-muted", formatDate(entry.date));
  if (entry.date) time.dateTime = entry.date;
  head.append(time);

  for (const tag of entry.tags ?? []) {
    const key = String(tag).toLowerCase();
    head.append(el("span", `tag${KNOWN_TAGS.has(key) ? ` tag-${key}` : ""}`, key));
  }
  article.append(head);

  if (entry.body) {
    article.append(el("p", "text-muted mt-2 leading-relaxed", entry.body));
  }

  const items = (entry.items ?? []).filter(Boolean);
  if (items.length) {
    const list = el("ul", "mt-2.5 flex flex-col gap-1.5 list-disc pl-5 marker:text-muted");
    for (const item of items) list.append(el("li", "text-sm", item));
    article.append(list);
  }

  return article;
}

function buildDialog() {
  const dialog = createDialog("Updates", "max-w-[820px]");

  const title = el("h2", null, "Updates");
  const notice = el("p", "text-muted text-[13px] empty:hidden");
  const entries = el("section", "mt-5 empty:hidden");
  const status = el("p", `${STATUS} text-muted`);

  dialog.append(title, notice, entries, status);
  return { dialog, notice, entries, status };
}

async function loadEntries() {
  let doc;
  try {
    const response = await fetch(UPDATES_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    doc = await response.json();
  } catch (error) {
    ui.status.className = `${STATUS} text-danger`;
    ui.status.textContent = `Could not load updates: ${error.message}`;
    return;
  }

  loaded = true;
  ui.notice.textContent = doc.notice ?? "";

  const entries = Array.isArray(doc.entries) ? [...doc.entries] : [];
  if (!entries.length) {
    ui.status.textContent = "No updates have been posted yet.";
    return;
  }

  // Newest first. Ties keep their file order, which is a stable sort in every
  // engine we care about.
  entries.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));

  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => fragment.append(renderEntry(entry, index === 0)));
  ui.entries.replaceChildren(fragment);
  ui.status.textContent = "";
}

export async function openUpdates() {
  if (!ui) ui = buildDialog();
  showDialog(ui.dialog);

  if (loaded) return;
  ui.status.className = `${STATUS} text-muted`;
  ui.status.textContent = "Loading…";
  await loadEntries();
}

export function mountUpdatesModal() {
  mountTrigger("data-open-updates", OPEN_PARAM, openUpdates);
}
