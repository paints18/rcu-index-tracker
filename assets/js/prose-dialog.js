/**
 * Dialogs that are nothing but headed text: Help and About.
 *
 * Both are written as data — a list of sections, each holding paragraphs and
 * bullet lists — and rendered here, so neither module spends fifty lines of
 * createElement around its own prose. They are built in JS rather than written
 * into index.html for the same reason Settings is: the nav that offers them sits
 * on the tracker and on the editor, and a visitor who never opens Help should
 * never pay for its DOM.
 *
 * A section's blocks may be:
 *   "text"          a paragraph
 *   ["one", "two"]  a bullet list
 *   an Element      appended as it is, for anything that has to change after it
 *                   is built (see the pet-list line in About)
 *
 * Inside a string, `**like this**` comes out bold. That is the whole markup
 * language, and it exists because the things these dialogs explain — Bulk edit,
 * Backup, the All column — are named controls on screen, and prose that does not
 * point straight at them is no help at all.
 */

import { createDialog } from "./modal.js";

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Text with its `**bold**` spans lifted out into <strong>. */
function rich(text) {
  const fragment = document.createDocumentFragment();

  // Odd-numbered parts are what sat between a pair of markers.
  text.split("**").forEach((part, index) => {
    if (!part) return;
    fragment.append(index % 2 ? el("strong", "font-semibold text-ink", part) : part);
  });
  return fragment;
}

function renderBlock(block) {
  if (block instanceof Element) return block;

  if (Array.isArray(block)) {
    const list = el("ul", "mt-2 flex flex-col gap-1.5 list-disc pl-5 marker:text-muted");
    for (const item of block) {
      const li = el("li", "text-sm text-muted leading-relaxed");
      li.append(rich(item));
      list.append(li);
    }
    return list;
  }

  const paragraph = el("p", "mt-2 text-sm text-muted leading-relaxed");
  paragraph.append(rich(block));
  return paragraph;
}

/**
 * @param {string} label Dialog title, and its accessible name.
 * @param {string|null} intro One line under the title, or null.
 * @param {Array<{title?: string, blocks: Array}>} sections A section with no
 *   title is just its blocks — About is short enough not to need headings.
 * @returns {HTMLDialogElement}
 */
export function buildProseDialog(label, intro, sections) {
  const dialog = createDialog(label);
  dialog.append(el("h2", null, label));
  if (intro) dialog.append(el("p", "text-muted text-[13px]", intro));

  const body = el("div", "mt-4");

  for (const section of sections) {
    const node = el("section", "prose-group");
    if (section.title) node.append(el("h3", "section-title mb-2", section.title));
    for (const block of section.blocks) node.append(renderBlock(block));
    body.append(node);
  }

  dialog.append(body);
  return dialog;
}
