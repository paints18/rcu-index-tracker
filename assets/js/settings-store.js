/**
 * Site settings — appearance and tracker defaults.
 *
 * Kept separate from progress (store.js) on purpose: settings are per-browser
 * preferences, progress is per-profile data. Clearing one should never mean
 * losing the other.
 *
 * Applying settings means writing attributes onto <html>; the stylesheet does
 * the rest. Each page also runs a tiny inline copy of `apply` in its <head> so
 * the theme is correct on the very first paint instead of flashing the default
 * and correcting itself.
 */

const KEY = "rcu:v1:settings";

export const MODES = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Colour themes. A theme is a whole palette, not just an accent: the hue is
 * stirred through the surfaces and borders too, and it works in both light and
 * dark — the mode setting is a separate axis.
 *
 * `colors` is the theme's two working colours, in the order the UI uses them:
 * `[--accent-base, --accent-2]`, matching `:root[data-theme="…"]` in
 * `styles/tailwind.css`. It is what the picker's swatch paints, so a sample
 * looks like the theme it selects whatever theme is currently on.
 *
 * The swatch is deliberately a two-tone chip of those two colours and nothing
 * else — not the palette a theme is named after. A row of recognisable flags is
 * exactly what this picker should not be. There are no visible names and no
 * headings either; `label` is carried only as the accessible name, so it
 * reaches a screen reader and not the screen.
 *
 * `periwinkle` is the default and is the one theme that writes no attribute.
 */
export const THEMES = [
  { id: "periwinkle", label: "Periwinkle", colors: ["#7c9cff", "#48c98a"] },
  { id: "sky", label: "Sky", colors: ["#56b6ff", "#7ee0ff"] },
  { id: "meadow", label: "Meadow", colors: ["#43c98b", "#a8e05f"] },
  { id: "toxic", label: "Toxic", colors: ["#6dd44a", "#d6f24a"] },
  { id: "gold", label: "Gold", colors: ["#e8c14a", "#f0883e"] },
  { id: "rose", label: "Rose", colors: ["#f2777a", "#ffb36b"] },
  { id: "galaxy", label: "Galaxy", colors: ["#b07cf0", "#6f8cff"] },
  { id: "cyan", label: "Cyan", colors: ["#4cc9d9", "#5be0a8"] },

  { id: "rainbow", label: "Rainbow", colors: ["#ff8a4c", "#a86bf0"] },
  { id: "trans", label: "Trans", colors: ["#5bcefa", "#f5a9b8"] },
  { id: "lesbian", label: "Lesbian", colors: ["#ff9a56", "#d362a4"] },
  { id: "bisexual", label: "Bisexual", colors: ["#f04a94", "#6f8cff"] },
  { id: "pan", label: "Pansexual", colors: ["#ff4fa3", "#ffd63d"] },
  { id: "nonbinary", label: "Non-binary", colors: ["#f2e34a", "#b47bea"] },
  { id: "asexual", label: "Asexual", colors: ["#a86bd6", "#b9bcc6"] },
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));

export const DENSITIES = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

/**
 * Table columns that can be turned off, in table order. The pet name and the
 * variant tick columns are the point of the table, so they are not in here.
 */
export const COLUMNS = [
  { id: "source", label: "Source" },
  { id: "rarity", label: "Rarity" },
  { id: "clicks", label: "Clicks" },
];

export const DEFAULTS = {
  mode: "auto",
  theme: "periwinkle",
  density: "comfortable",
  columns: Object.fromEntries(COLUMNS.map((c) => [c.id, true])),
  hideCompleted: false,
  /** The "ticks are locked" note under the profile name, once dismissed. */
  lockNoteDismissed: false,
  /** One-time hint about bulk edit; not a choice, just a "seen it" flag. */
  bulkHintSeen: false,
  defaultCategory: "all",
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return withDefaults(raw ? JSON.parse(raw) : {});
  } catch {
    return withDefaults({});
  }
}

/**
 * `columns` is merged key by key rather than replaced wholesale, so a column
 * added in a later release starts out visible instead of disappearing for
 * everyone whose saved settings were written before it existed.
 */
function withDefaults(stored) {
  // Anything that is not a plain object (a hand-edited array or string parses
  // fine and would otherwise spread into the settings as indexed keys).
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};

  const { showClicks, accent, ...rest } = stored;
  const storedColumns =
    stored.columns && typeof stored.columns === "object" && !Array.isArray(stored.columns)
      ? stored.columns
      : {};
  const columns = { ...DEFAULTS.columns, ...storedColumns };

  // The Source column was the Egg column; carry a saved "hidden" over.
  if (storedColumns.source == null && typeof storedColumns.egg === "boolean") columns.source = storedColumns.egg;
  delete columns.egg;

  // Settings saved before this was a per-column list carried a single flag.
  if (stored.columns == null && showClicks === false) columns.clicks = false;

  // A value of the wrong type falls back to its default rather than reaching
  // the UI as a string, number or object.
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (typeof fallback === "boolean" && key in rest && typeof rest[key] !== "boolean") delete rest[key];
  }
  if (!MODES.some((m) => m.id === rest.mode)) delete rest.mode;
  if (!DENSITIES.some((d) => d.id === rest.density)) delete rest.density;
  for (const c of COLUMNS) if (typeof columns[c.id] !== "boolean") columns[c.id] = true;

  // Accents became whole themes. The five accent ids that survived as themes
  // keep their name, so an old setting carries straight over; the rest fall
  // back to the default.
  if (rest.theme == null && accent) rest.theme = accent;
  if (!THEME_IDS.has(rest.theme)) delete rest.theme;

  // Settings saved before there was a default category, or with the old
  // "first category with pets" blank choice, fall back to the current default.
  if (!rest.defaultCategory || typeof rest.defaultCategory !== "string") delete rest.defaultCategory;

  return { ...DEFAULTS, ...rest, columns };
}

export function saveSettings(patch) {
  const safePatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = withDefaults({ ...loadSettings(), ...safePatch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage disabled — settings simply will not persist. Still apply them.
  }
  applySettings(next);
  return next;
}

export function resetSettings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  const defaults = withDefaults({});
  applySettings(defaults);
  return defaults;
}

/**
 * Only non-default values become attributes, so the CSS defaults stay in charge
 * and the DOM stays readable.
 */
export function applySettings(settings = loadSettings()) {
  const root = document.documentElement;

  if (settings.mode && settings.mode !== "auto") root.dataset.mode = settings.mode;
  else delete root.dataset.mode;

  if (settings.theme && settings.theme !== "periwinkle") root.dataset.theme = settings.theme;
  else delete root.dataset.theme;

  if (settings.density === "compact") root.dataset.density = "compact";
  else delete root.dataset.density;

  // Bulk edit is always on; the attribute stays because the stylesheet keys off
  // it (see [data-bulk="on"] in tailwind.css) rather than because it is still a
  // choice.
  root.dataset.bulk = "on";

  // One space-separated list rather than an attribute per column, matched in CSS
  // with `[data-hide-cols~="source"]`.
  const hidden = COLUMNS.filter((c) => settings.columns?.[c.id] === false).map((c) => c.id);
  if (hidden.length) root.dataset.hideCols = hidden.join(" ");
  else delete root.dataset.hideCols;

  return settings;
}
