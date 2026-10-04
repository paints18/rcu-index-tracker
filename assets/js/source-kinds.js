/**
 * What kind of source a pet's `source` is, worked out from its name. The grid
 * view's hover card picks its icon from this.
 *
 * The first pattern that matches wins, so "Top ..." is checked before anything
 * else: a leaderboard that happens to mention a pack is still a leaderboard.
 * Anything that matches nothing (events, rewards, sources not seen before) is
 * "other".
 */
const SOURCE_KINDS = [
  { id: "leaderboard", pattern: /^Top\b/i },
  { id: "egg", pattern: /\bEgg$/i },
  { id: "pack", pattern: /\bPack$/i },
  { id: "shop", pattern: /\bShop$/i },
  { id: "chest", pattern: /\bChest$/i },
  { id: "minigame", pattern: /\bMinigame$/i },
];

/** @param {string} source @returns {{ id: string }} */
export function sourceKind(source) {
  return SOURCE_KINDS.find((kind) => kind.pattern.test(source)) ?? { id: "other" };
}
