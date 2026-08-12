/**
 * Shared plumbing for the site's dialogs.
 *
 * The tracker is the only real page now — settings, updates and the editor are
 * all dialogs opened from the nav. Each of those needs the same three things: a
 * <dialog> with a close ✕, a trigger that opens it, and a URL parameter so links
 * to the page it replaced still land in the right place. That is all this is;
 * what goes inside a dialog is each modal's own business.
 *
 * None of them use element ids. Ids are exactly what collides once a page's
 * markup moves into a dialog alongside another page's.
 */

export function createDialog(label, className = "") {
  const dialog = document.createElement("dialog");
  dialog.className = `dialog${className ? ` ${className}` : ""}`;
  // aria-label rather than aria-labelledby, which would need an id on the
  // heading.
  dialog.setAttribute("aria-label", label);

  // A form[method=dialog] closes its dialog with no script at all, so the ✕
  // keeps working even if the module that built it throws later.
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "float-right -mt-2 -mr-1.5";

  const close = document.createElement("button");
  close.className = "dialog-x";
  close.textContent = "×";
  close.setAttribute("aria-label", `Close ${label.toLowerCase()}`);

  form.append(close);
  dialog.append(form);
  document.body.append(dialog);
  return dialog;
}

export function showDialog(dialog) {
  // showModal() throws on an already-open dialog, and a nav trigger is one
  // click away from being pressed twice.
  if (!dialog.open) dialog.showModal();
}

// Click-outside-to-close, for every dialog on the page — the ones built by
// createDialog() above and the static ones in index.html/editor.html alike.
// A click on the ::backdrop targets the <dialog> element itself, same as a
// click on the dialog's own padding — so target alone can't tell them apart.
// The coordinates can: only a backdrop click falls outside the dialog's box.
document.addEventListener("click", (event) => {
  const dialog = event.target;
  if (dialog.nodeName !== "DIALOG" || !dialog.open) return;
  const rect = dialog.getBoundingClientRect();
  const inside =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  if (!inside) dialog.close();
});

/** Attributes already wired, so a second mount on the same page is a no-op. */
const mounted = new Set();

/**
 * Wire every `[attr]` trigger on the page to `open`, and open it immediately if
 * the page was loaded with `?param`.
 *
 * @param {string} attr Trigger marker, e.g. `"data-open-updates"`.
 * @param {string|null} param URL parameter that opens it on load, or null.
 * @param {Function} open
 * @returns {boolean} False if this attribute was already mounted.
 */
export function mountTrigger(attr, param, open) {
  // The editor mounts the modals its own nav offers, and inside the editor
  // dialog that is a page which has already mounted them.
  if (mounted.has(attr)) return false;
  mounted.add(attr);

  // Delegated, so a trigger rendered later still works.
  document.addEventListener("click", (event) => {
    if (event.target.closest(`[${attr}]`)) open();
  });

  const params = new URLSearchParams(location.search);
  if (!param || !params.has(param)) return true;

  // Drop the parameter so a refresh does not reopen the dialog, and so the URL
  // people copy is just the tracker.
  params.delete(param);
  const query = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
  );

  // On a microtask, so the caller finishes wiring itself before its dialog is
  // asked to open.
  queueMicrotask(open);
  return true;
}
