/**
 * The few things about the tracker that are not obvious, in a dialog.
 *
 * Deliberately short. Everything it could describe is already on screen behind
 * it, so the only lines worth keeping are the ones a visitor could not work out
 * by clicking: the bar in the All column, what the bulk checkboxes are scoped
 * to, shift-click, and that progress never leaves this browser on its own.
 * Anything self-evident — what Undo does, what Search does, what is in Settings
 * — is left to the control that says it.
 *
 * Built on first open; see prose-dialog.js. `index.html?help` opens it on load.
 */

import { showDialog, mountTrigger } from "./modal.js";
import { buildProseDialog } from "./prose-dialog.js";

const OPEN_PARAM = "help";

const SECTIONS = [
  {
    title: "Ticking pets",
    blocks: [
      "Tick a box for each variant you have in your in-game index. The circle in " +
        "the **All** column covers every variant that pet has, and shows a bar when " +
        "you have some of them but not all.",
    ],
  },
  {
    title: "Keyboard",
    blocks: [
      [
        "**Arrow keys** - move focus to the next box: Up/Down stays in the column, Left/Right in the row.",
        "**Home** / **End** - jump to the first or last box in a row.",
        "**Ctrl+Home** / **Ctrl+End** - jump to the first or last box in the table.",
        "**Enter** / **Shift+Enter** - move focus down or up a row.",
        "**Space** - tick the box that has focus.",
      ],
    ],
  },
  {
    title: "Filling in a lot at once",
    blocks: [
      "Turn on **Bulk edit** in the filter bar. Every column then gets a checkbox at " +
        "the top that fills that variant in for the pets currently listed, so filter " +
        "or search first and it only touches those. Clicking a full one clears the " +
        "column again.",
      "**Shift-click** a box after another one in the same column to fill in the rows " +
        "between them. That works with Bulk edit off as well.",
    ],
  },
  {
    title: "Profiles",
    blocks: [
      "Each profile keeps its own checklist. **Switch profile** is also where new " +
        "ones are made, so an alt's progress stays separate from your main's.",
      "**Export pets** copies what you're still missing as plain text, for index " +
        "services.",
    ],
  },
  {
    title: "Another device",
    blocks: [
      "Progress is saved in this browser, so a phone or a second browser starts empty. " +
        "**Backup/Import** turns a profile into a code; paste it into the Import tab there.",
    ],
  },
];

let dialog = null;

export function openHelp() {
  dialog ??= buildProseDialog("Help", null, SECTIONS);
  showDialog(dialog);
}

export function mountHelpModal() {
  mountTrigger("data-open-help", OPEN_PARAM, openHelp);
}
