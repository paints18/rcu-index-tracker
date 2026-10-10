/**
 * The "What's new" popup: the newest changelog entry, until it is dismissed.
 *
 * It opens on load when the newest entry in data/updates.json is not the one the
 * visitor last dismissed, so posting a new entry is all it takes to announce it.
 * Only the newest entry is shown; the rest are one click away in the Updates
 * dialog.
 *
 * An entry counts as seen when the popup is closed (the x, Got it, All updates,
 * Escape or a click outside), not when it opens: a refresh does not close a
 * dialog, so the popup comes back until someone dismisses it.
 *
 * A visitor with no profile is a first-time visitor: the changelog means nothing
 * to them, so the entry is marked as seen without showing it.
 */

import { createDialog, showDialog } from "./modal.js";
import { fetchUpdates, sortEntries, renderEntryBody, openUpdates } from "./updates-modal.js";
import { loadSettings, saveSettings } from "./settings-store.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildDialog(entry) {
  const dialog = createDialog("What's new", "max-w-[460px]");

  dialog.append(el("h2", null, "What's new"));

  const body = el("div", "mt-4");
  body.append(...renderEntryBody(entry));
  dialog.append(body);

  const footer = el("div", "flex items-center justify-between gap-3 mt-5");
  const all = el("button", "linkish text-[13px]", "All updates →");
  all.type = "button";
  all.addEventListener("click", () => {
    dialog.close();
    openUpdates();
  });
  const done = el("button", "btn btn-primary", "Got it");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  footer.append(all, done);
  dialog.append(footer);

  dialog.addEventListener("close", () => {
    saveSettings({ updatesSeenId: entry.id });
    dialog.remove();
  });
  return dialog;
}

/**
 * @param {{ hasProfiles: boolean }} cfg
 * @returns {Promise<boolean>} Whether the popup was shown.
 */
export async function maybeShowWhatsNew({ hasProfiles }) {
  let latest;
  try {
    [latest] = sortEntries(await fetchUpdates());
  } catch {
    return false; // The changelog is a nicety; a failed load is not worth a message.
  }
  if (!latest?.id) return false;

  const settings = loadSettings();
  if (settings.updatesSeenId === latest.id) return false;

  if (!hasProfiles) {
    saveSettings({ updatesSeenId: latest.id });
    return false;
  }

  showDialog(buildDialog(latest));
  return true;
}
