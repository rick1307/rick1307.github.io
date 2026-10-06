/*
  Wild Ledger universal star standing.

  Star standing is derived only from cumulative Earned LEAP inside one community.
  It is not configurable per community and does not belong in community CONFIG.
*/
(() => {
  const THRESHOLDS = Object.freeze([1, 10, 20, 50, 100]);

  function normalizeEarnedLeap(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function countForEarnedLeap(value) {
    const earnedLeap = normalizeEarnedLeap(value);
    let count = 0;
    for (const threshold of THRESHOLDS) {
      if (earnedLeap >= threshold) count += 1;
    }
    return count;
  }

  function glyphs(count, { showEmpty = true } = {}) {
    const safe = Math.max(0, Math.min(5, Math.trunc(Number(count) || 0)));
    return showEmpty ? `${"★".repeat(safe)}${"☆".repeat(5 - safe)}` : "★".repeat(safe);
  }

  function standingForEarnedLeap(value) {
    const earnedLeap = normalizeEarnedLeap(value);
    const count = countForEarnedLeap(earnedLeap);
    const currentThreshold = count > 0 ? THRESHOLDS[count - 1] : 0;
    const nextThreshold = count < 5 ? THRESHOLDS[count] : null;
    const display = glyphs(count);
    return Object.freeze({
      earnedLeap,
      count,
      display,
      currentThreshold,
      nextThreshold,
      remaining: nextThreshold === null ? 0 : Math.max(0, nextThreshold - earnedLeap),
      ariaLabel: `${count} of 5 stars`
    });
  }

  globalThis.WILD_LEDGER_STAR_SYSTEM = Object.freeze({
    thresholds: THRESHOLDS,
    countForEarnedLeap,
    glyphs,
    standingForEarnedLeap
  });
})();
