/**
 * The few things about the tracker that are not obvious, in a dialog.
 *
 * Deliberately short. Everything it could describe is already on screen behind
 * it, so the only lines worth keeping are the ones a visitor could not work out
 * by clicking: the bar in the All column, what the bulk checkboxes are scoped
 * to, shift-click, the keyboard shortcuts, what the API import does to a
 * profile, and that progress never leaves this browser on its own.
 * Anything self-evident — what Undo does, what Search does, what is in Settings
 * — is left to the control that says it.
 *
 * Split into tabs so no page of it needs scrolling. Built on first open;
 * `index.html?help` opens it on load.
 */

import { createDialog, showDialog, mountTrigger } from "./modal.js";
import { el, rich, renderBlock } from "./prose-dialog.js";

const OPEN_PARAM = "help";

/** Shown in the Keyboard tab, as [key, list view, grid view]. A row with no grid text applies to both views. */
const SHORTCUTS = [
  ["Arrow keys", "Move between boxes", "Move between pets"],
  ["Home / End", "First or last box in the row", "First or last pet in the row"],
  ["Ctrl+Home / Ctrl+End", "First or last box in the table", "First or last pet"],
  ["Space", "Tick the box", "Tick the pet"],
  ["Enter", "Move down a row (Shift+Enter: up)", "Tick the pet"],
  ["Page Up / Page Down", "-", "Move a screenful"],
  ["1 - 4", "-", "Normal, Golden, Toxic or Galaxy"],
  ["/", "Jump to Search (both views)"],
  ["Ctrl+Z", "Undo the last change (both views)"],
];

/**
 * A table at desktop width; stacked on a phone, where three columns of prose do
 * not fit. Each cell carries its own view label for the stacked layout.
 */
function shortcutTable() {
  const cols = "sm:grid sm:grid-cols-[11rem_1fr_1fr] sm:gap-x-4";
  const table = el("div", "mt-2");
  table.setAttribute("role", "table");

  const head = el("div", `${cols} hidden text-muted text-[12px] uppercase tracking-wide py-1.5 font-semibold`);
  head.setAttribute("role", "row");
  for (const label of ["Key", "Grid view", "List view"]) {
    const cell = el("div", null, label);
    cell.setAttribute("role", "columnheader");
    head.append(cell);
  }
  table.append(head);

  const cell = (text, label, span) => {
    const node = el("div", `text-sm text-muted leading-relaxed${span ? " sm:col-span-2" : ""}`);
    node.setAttribute("role", "cell");
    if (label) node.append(el("span", "sm:hidden text-[12px] uppercase tracking-wide mr-1.5", label));
    node.append(text);
    return node;
  };

  for (const [key, list, grid] of SHORTCUTS) {
    const row = el("div", `${cols} border-t border-edge py-1.5`);
    row.setAttribute("role", "row");
    const name = el("div", "text-sm font-semibold text-ink");
    name.setAttribute("role", "rowheader");
    name.textContent = key;
    if (grid === undefined) {
      row.append(name, cell(list, "", true));
    } else {
      row.append(name, cell(grid, "Grid"), cell(list, "List"));
    }
    table.append(row);
  }
  return table;
}

/** A short note set apart from the steps around it. */
function callout(text) {
  const note = el("p", "mt-3 border-l-2 border-accent pl-3 text-sm text-muted leading-relaxed");
  note.append(rich(text));
  return note;
}

function steps(items) {
  const list = el("ol", "mt-2 flex flex-col gap-1.5 list-decimal pl-5 marker:text-muted");
  for (const item of items) {
    const li = el("li", "text-sm text-muted leading-relaxed");
    li.append(rich(item));
    list.append(li);
  }
  return list;
}

const TABS = [
  {
    id: "basics",
    label: "Basics",
    blocks: () => [
      "**Grid view** shows the in-game layout: pick a variant, then click a pet to " +
        "tick it. Pets you don't have yet are silhouettes.",
      "**List view** (top right) is a table with a box per variant. Tick each variant " +
        "you have in your in-game index. The circle in the **All** column covers every " +
        "variant that pet has, and shows a bar when you have some of them but not all.",
      el("h3", "section-title mt-5 mb-1", "Filling in a lot at once"),
      "In **List view**, every column has a checkbox at the top that fills that variant " +
        "in for the pets currently listed, so filter or search first and it only touches " +
        "those. Clicking a full one clears the column again.",
      "**Shift-click** a box after another one in the same column to fill in the rows " +
        "between them.",
    ],
  },
  {
    id: "keyboard",
    label: "Keyboard",
    blocks: () => [shortcutTable()],
  },
  {
    id: "import",
    label: "Import",
    blocks: () => [
      "Fill a profile from your in-game index instead of ticking by hand.",
      steps([
        "Get an access token from **rcu.powerfulstudio.xyz/public/access-tokens** " +
          "(sign in with Roblox, then Generate).",
        "Open **Backup/Import > From API**, or use the first screen. Enter your " +
          "Roblox username and the token, then press **Import from API**.",
        "The profile refreshes whenever the page loads, or when you press " +
          "the refresh icon next to the profile name. **Disconnect** unlinks it and keeps its ticks.",
      ]),
      callout(
        "Your in-game index is the source of truth, so ticks that are not in it " +
          "are removed. Imported profiles start locked to stay matched with the game.",
      ),
    ],
  },
  {
    id: "profiles",
    label: "Profiles",
    blocks: () => [
      "Each profile keeps its own checklist. **Switch profile** is also where new " +
        "ones are made, so an alt's progress stays separate from your main's.",
      "A locked profile can't be ticked by accident. Lock or unlock any profile in " +
        "**Settings > Your data**.",
      "**Export pets** builds a list of what you're missing, have, or all pets, as plain text, a " +
        "spreadsheet or a CSV file, for index services. To paste into Google Sheets or " +
        "Excel, choose **Spreadsheet** and copy. Spreadsheet and CSV have a column per " +
        "variant: caught is marked ✓, missing is blank, and - means the pet has no such " +
        "variant.",
      el("h3", "section-title mt-5 mb-1", "Another device"),
      "Progress is saved in this browser, so a phone or a second browser starts empty. " +
        "**Backup/Import** turns a profile into a code; paste it into the Import tab there.",
    ],
  },
];

function buildHelpDialog() {
  const dialog = createDialog("Help");
  dialog.append(el("h2", null, "Help"));

  const tabs = el("div", "tabs mt-4");
  tabs.setAttribute("role", "tablist");
  const panels = el("div");
  const parts = [];

  for (const tab of TABS) {
    const button = el("button", "tab", tab.label);
    button.type = "button";
    button.id = `help-tab-${tab.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `help-panel-${tab.id}`);

    const panel = el("div");
    panel.id = `help-panel-${tab.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.append(...tab.blocks().map(renderBlock));

    tabs.append(button);
    panels.append(panel);
    parts.push({ button, panel });
  }

  function select(index, focus = false) {
    parts.forEach(({ button, panel }, i) => {
      const active = i === index;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    });
    if (focus) parts[index].button.focus();
  }

  tabs.addEventListener("click", (event) => {
    const index = parts.findIndex((p) => p.button === event.target.closest("button"));
    if (index >= 0) select(index);
  });
  tabs.addEventListener("keydown", (event) => {
    const at = parts.findIndex((p) => p.button === document.activeElement);
    if (at < 0) return;
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (move) {
      event.preventDefault();
      select((at + move + parts.length) % parts.length, true);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(event.key === "Home" ? 0 : parts.length - 1, true);
    }
  });

  select(0);
  dialog.append(tabs, panels);

  // Panels differ in height; sizing the container to the tallest keeps the dialog
  // from jumping when you change tab. Measured once it is on screen.
  dialog.evenOut = () => {
    panels.style.minHeight = "";
    let tallest = 0;
    parts.forEach(({ panel }) => {
      panel.hidden = false;
      tallest = Math.max(tallest, panel.offsetHeight);
      panel.hidden = true;
    });
    panels.style.minHeight = `${tallest}px`;
    select(parts.findIndex((p) => p.button.classList.contains("is-active")));
  };
  return dialog;
}

let dialog = null;
let sized = false;

export function openHelp() {
  dialog ??= buildHelpDialog();
  showDialog(dialog);
  if (!sized) {
    sized = true;
    dialog.evenOut();
  }
}

export function mountHelpModal() {
  mountTrigger("data-open-help", OPEN_PARAM, openHelp);
}
