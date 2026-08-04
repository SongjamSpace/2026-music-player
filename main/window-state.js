'use strict';

/**
 * Where the window opens, and remembering where it was.
 *
 * Electron with no `x`/`y` centres on whichever display macOS calls primary, at a
 * fixed 1180×780. On a three-display desk that means the app opens small, on
 * whichever screen the OS happens to favour, every single launch — regardless of
 * where it was when you closed it.
 *
 * The rules, in order:
 *
 *   1. Reopen where it was last closed, if that place still exists.
 *   2. Otherwise fill the leftmost display, which is where this desk wants it.
 *
 * Rule 1 has to be conditional, and that is the whole reason this file is not four
 * lines inside createWindow. Saved coordinates describe a display arrangement that
 * may be gone: unplug the monitor the window was on, or move it in Arrangement, and
 * restoring literally puts the window somewhere with no screen — visible nowhere,
 * with no way to drag it back. The check is not "is x within a display" either; a
 * window can straddle two.
 *
 * Pure functions over a plain list of display rectangles, so every arrangement this
 * desk can produce is testable without owning three monitors — see
 * scripts/window-state-check.js.
 */

/** Below this fraction of the window on screen, treat the saved place as gone. */
const MIN_VISIBLE_FRACTION = 0.3;
/** Leave a little of the work area free so the window reads as a window. */
const FILL_INSET = 0;

const DEFAULT_SIZE = { width: 1180, height: 780 };
const MIN_SIZE = { width: 860, height: 560 };

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * How much of `rect` falls on any of these displays, as a fraction of its area.
 *
 * Summed across displays rather than taking the best one: a window deliberately
 * straddling two screens is fully visible, and judging it against each display
 * separately would call it half-lost and move it.
 */
function visibleFraction(rect, displays) {
  const total = area(rect);
  if (!total) return 0;
  let seen = 0;
  for (const d of displays) seen += area(intersection(rect, d.workArea || d.bounds));
  return Math.min(1, seen / total);
}

/** The display whose work area starts furthest left, ties broken by the top edge. */
function leftmostDisplay(displays) {
  return displays.reduce((best, d) => {
    if (!best) return d;
    const a = d.workArea || d.bounds;
    const b = best.workArea || best.bounds;
    if (a.x !== b.x) return a.x < b.x ? d : best;
    return a.y < b.y ? d : best;
  }, null);
}

function isValidRect(rect) {
  return !!rect &&
    [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number' && isFinite(n)) &&
    rect.width >= 1 && rect.height >= 1;
}

/**
 * Fill a display, respecting the minimum window size.
 *
 * `workArea` rather than `bounds`, so the window sits under the menu bar and clear of
 * the Dock instead of behind them.
 */
function fillDisplay(display) {
  const wa = (display && (display.workArea || display.bounds)) || { x: 0, y: 0, ...DEFAULT_SIZE };
  return {
    x: wa.x + FILL_INSET,
    y: wa.y + FILL_INSET,
    width: Math.max(MIN_SIZE.width, wa.width - FILL_INSET * 2),
    height: Math.max(MIN_SIZE.height, wa.height - FILL_INSET * 2),
  };
}

/**
 * Decide the bounds to open with.
 *
 * @param {object|null} saved     `{x, y, width, height, maximized}` from the store
 * @param {Array} displays        Electron's `screen.getAllDisplays()` shape
 * @returns {{x, y, width, height, maximized: boolean, reason: string}}
 *   `reason` is returned rather than logged in here so this stays pure, and it is
 *   worth having: "why did it open there" is otherwise unanswerable.
 */
function chooseBounds(saved, displays) {
  const screens = Array.isArray(displays) && displays.length ? displays : [];
  if (!screens.length) {
    return { ...DEFAULT_SIZE, x: undefined, y: undefined, maximized: false, reason: 'no displays reported' };
  }

  if (isValidRect(saved)) {
    const fraction = visibleFraction(saved, screens);
    if (fraction >= MIN_VISIBLE_FRACTION) {
      return {
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width: Math.max(MIN_SIZE.width, Math.round(saved.width)),
        height: Math.max(MIN_SIZE.height, Math.round(saved.height)),
        maximized: !!saved.maximized,
        reason: 'restored',
      };
    }
    return {
      ...fillDisplay(leftmostDisplay(screens)),
      maximized: !!saved.maximized,
      reason: 'saved position is off-screen now (' + Math.round(fraction * 100) + '% visible)',
    };
  }

  return {
    ...fillDisplay(leftmostDisplay(screens)),
    maximized: false,
    reason: 'first run — filling the leftmost display',
  };
}

/**
 * What to write to the store for a window in this state.
 *
 * Normal bounds, never the maximized or full-screen rectangle: saving the latter
 * would restore a window that cannot be un-maximized back to anything sensible.
 * Electron's `getNormalBounds()` is exactly this, which is why it is asked for rather
 * than `getBounds()`.
 *
 * Full screen is deliberately not remembered. It is a transient mode here — `F`
 * toggles it for video — and reopening into it hides the traffic lights on a window
 * the user did not ask to be full screen.
 */
function stateToSave(win) {
  if (!win || win.isDestroyed()) return null;
  const bounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
  if (!isValidRect(bounds)) return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized: !!win.isMaximized(),
  };
}

module.exports = {
  chooseBounds,
  stateToSave,
  visibleFraction,
  leftmostDisplay,
  fillDisplay,
  MIN_VISIBLE_FRACTION,
  MIN_SIZE,
  DEFAULT_SIZE,
};
