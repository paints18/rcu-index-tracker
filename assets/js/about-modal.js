/**
 * What this is, who to tell when a pet is wrong, and where the data goes.
 *
 * Six lines and no headings: About is where "can anyone else see my progress?"
 * and "a pet is missing" get answered, and nothing else needs to be here.
 *
 * The pet-list line is the exception to it being fixed prose — it is read off
 * the loaded index rather than written down, because a count in an About box is
 * wrong within the week otherwise. The tracker hands its own index over (see
 * mountAboutModal); anywhere else the dialog fetches one after it is on screen
 * and fills the line in when it lands.
 */

import { showDialog, mountTrigger } from "./modal.js";
import { buildProseDialog, el } from "./prose-dialog.js";
import { loadIndex } from "./data.js";

const OPEN_PARAM = "about";

/** Options from mountAboutModal(). */
let host = {};

let dialog = null;
let stats = null;
let indexPromise = null;

function sections() {
  stats = el("p", "mt-2 text-sm text-muted tabular-nums");

  return [
    {
      blocks: [
        stats,
        "This tracker is updated manually. New pets may take a while to add.",
        "Progress is saved locally in your browser and never leaves your device.",
        "Made by **paints**. Ping me in the Powerful Studio Discord if a pet is missing or listed wrong, or if you have feedback for the tracker.",
        "Not affiliated with Rebirth Champions Ultimate or Roblox.",
      ],
    },
  ];
}

function renderStats(index) {
  if (!index) {
    stats.textContent = "The pet list could not be loaded.";
    return;
  }

  const parts = [
    `${index.totalPets.toLocaleString()} pets`,
    `${index.totalTicks.toLocaleString()} variants`,
  ];

  const when = index.generatedAt ? new Date(index.generatedAt) : null;
  if (when && !Number.isNaN(when.valueOf())) {
    parts.push(
      `updated ${when.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}`,
    );
  }

  // Middots rather than a sentence: it is a meta line, not prose.
  stats.textContent = parts.join(" · ");
}

export async function openAbout() {
  dialog ??= buildProseDialog(
    "About",
    "A pet index tracker for Rebirth Champions Ultimate.",
    sections(),
  );

  const supplied = host.getIndex?.();
  if (supplied) renderStats(supplied);
  else stats.textContent = "Counting the pet list…";

  showDialog(dialog);
  if (supplied) return;

  indexPromise ??= loadIndex().catch(() => null);
  const index = await indexPromise;
  // Closed while we were waiting — the next open asks again, and by then the
  // promise above has already settled.
  if (dialog.open) renderStats(index);
}

/**
 * @param {object}   [options]
 * @param {Function} [options.getIndex] Returns an already-loaded pet index, or a
 *   falsy value to have the dialog fetch its own.
 */
export function mountAboutModal(options = {}) {
  if (!mountTrigger("data-open-about", OPEN_PARAM, openAbout)) return;
  host = options;
}
