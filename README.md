# RCU Index Tracker

A pet index tracker for **Rebirth Champions Ultimate**. Tick off the
variants you've indexed in-game and track your progress. No account, just a
profile name.

**Open the tracker:** [paints18.github.io/rcu-index-tracker](https://paints18.github.io/rcu-index-tracker/)

---

## Features

- Grid view (the default; Grid view/List view toggle in the category header)
  shows the in-game index layout: one variant at a time, 7 tiles per row,
  not-indexed pets as silhouettes, and a hover card with rarity, clicks and
  egg. Clicking a tile ticks it. Search, Egg, Rarity, counts and Undo are shared
  with the list. The Status menu offers All pets and Missing, which lists
  the pets not yet ticked for the variant on show (Normal, Golden, Toxic or
  Galaxy). The Missing menu is disabled and reset to No filter. The chosen view
  is remembered in this browser.
- List view is a table with a box per variant. The **All** column shows a full
  or partial ring depending on how many of a pet's variants you own. Clicking the
  Egg header groups the list by egg, with the eggs in list order; clicking it
  again restores the default order.
- Browse by category, or filter by name, egg, rarity, completion status, or
  a specific missing variant. Rarity is a checklist: tick any number of
  rarities, or none for all. The Egg, Rarity, Status and Missing menus are
  drawn by the page, not the browser, so they look and behave the same in
  every browser. Status and Missing apply to List view only. Filters stay set
  when you change category; an egg or rarity the new category does not have is
  skipped there and comes back when you return.
- List view: fill a whole column at once for the pets currently shown, or
  shift-click to fill a range. Undo reverts any of these bulk edits.
- Keyboard navigation in both views: arrow keys, Home/End, Ctrl+Home/Ctrl+End
  and Space to tick. List view also has Enter/Shift+Enter to move down or up a
  row. Grid view also has Page Up/Page Down, and 1-4 to switch variant. `/`
  focuses Search and Ctrl+Z undoes.
- Multiple profiles, each with its own checklist.
- Backup/Import moves a profile between browsers or devices via a code.
- Import from the Powerful Studio API with a Roblox username and access
  token, from the first-run screen or Backup/Import > From API. An import
  replaces the profile's ticks with the in-game index, so ticks not in the game
  are removed. Linking a profile that has ticks asks for confirmation first, and
  an empty API response never clears a profile. Linked profiles refresh on page
  load, and the refresh icon button next to the profile name re-imports on
  demand. Disconnect removes the link and keeps the ticks.
- Profiles linked to the API are locked by default. A locked profile cannot
  be edited (list, grid, column checkboxes and Undo); clicking a tick shows a
  message instead. Settings > Your data has a Lock/Unlock button for each
  profile, so any profile can be locked or unlocked.
- Export pets builds a list of the pets you're missing, have, or all of them,
  as plain text, a spreadsheet or a CSV file, for trading or paying someone to
  index for you. Options: whole index, the tab the table is on, or the current
  filters; group by pet or by variant; comma or slash separator; abbreviated
  variant names; variant and rarity filters. The Spreadsheet format is
  tab-separated, for pasting into Google Sheets or Excel. Spreadsheet and CSV
  have one row per pet and a column per variant. A caught variant is marked ✓, a
  missing one is left blank, and a variant the pet does not have shows -. The
  List option chooses which pets get a row. Group by, separator and
  abbreviations apply to plain text only. The preview is editable, and the list
  can be copied or downloaded. Options are remembered in this browser.
- Light/dark mode, colour themes, a compact density option, and the ability
  to hide unused columns (Egg, Rarity, Clicks). A default category and
  hide-completed-pets option (List view only) are also available in Settings.

## Data

Progress is stored locally in the browser. There is no account and no
database, so progress does not leave your device and does not sync across
devices unless you use Backup/Import.

The optional API import (Backup/Import > From API) sends the Roblox username
and access token entered to a Cloudflare Worker (`worker/index.js`), which
forwards them to the Powerful Studio API and Roblox's username lookup. The
Worker does not store or log them. The username and token are kept in the
browser's local storage so a linked profile can refresh on page load.

## Development

- `npm run build` compiles `styles/tailwind.css` to `assets/styles.css`. The
  compiled file is committed and must be rebuilt after changing classes.
  `assets/grid-view.css` is hand-written.
- `npm run check` (`python tools/validate.py`) validates `data/pets.json`.
- `npm run serve` serves the site at `http://localhost:8765`.
- `python tools/add_new_pets.py` is a dry run that lists pets in the API that are
  not in `data/pets.json`, and blank `clicks` it can fill. With `--write` it
  appends new pets to the end of their tab (egg left blank), fills blank `clicks`,
  downloads grid icons as WebP into `assets/pets/`, and writes
  `data/pet-images.json`. It never changes a pet that is already in the file other
  than filling a blank `clicks`. Icons need Pillow (`pip install pillow`);
  `--skip-images` leaves them alone.
- `sw.js` is a service worker that caches the pet icons in the visitor's browser,
  because GitHub Pages only lets files be cached for ten minutes.
- `worker/` holds the Cloudflare Worker used by the API import. It allows
  requests from `https://paints18.github.io` and `http://localhost:8765`;
  change `ALLOWED_ORIGINS` in `worker/index.js` to host elsewhere, and
  redeploy it from the Cloudflare dashboard after editing.
- `.githooks/pre-commit` runs `tools/assign_codes.py` when `data/pets.json` is
  committed and stages `data/codes.json`. Enable it once per clone with
  `git config core.hooksPath .githooks`.
- `.github/workflows/deploy.yml` publishes `index.html`, `updates.html`,
  `settings.html`, `data/` and `assets/`.

## Reporting problems

This tracker is updated manually. If a pet is missing or listed wrong, or
you have feedback, contact **paints** in the Powerful Studio Discord.

---

Not affiliated with Rebirth Champions Ultimate or Roblox.
