#!/usr/bin/env node
'use strict';

/**
 * Checks main/window-state.js — where the window opens.
 *
 * Worth a harness precisely because it cannot be exercised by hand: the failure that
 * matters is a saved position on a display that no longer exists, which needs a
 * monitor unplugged between two launches. Get it wrong and the window opens somewhere
 * with no screen — invisible, and undraggable because there is nothing to drag it
 * from. So the arrangements are described as rectangles instead.
 *
 * Coordinates follow macOS: the primary display starts at 0,0 and a display to its
 * left has a negative x.
 *
 *   node scripts/window-state-check.js
 */

const ws = require('../main/window-state');

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(56) +
      (ok ? String(JSON.stringify(actual)).slice(0, 34)
          : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  );
}

/** A display, with a work area inset for the menu bar the way macOS reports it. */
function display(x, y, width, height, menuBar = 25) {
  return {
    bounds: { x, y, width, height },
    workArea: { x, y: y + menuBar, width, height: height - menuBar },
  };
}

// The desk this was written for: a laptop panel flanked by two larger screens, with
// the big one to the left of the primary.
const LEFT = display(-2560, 0, 2560, 1440);
const PRIMARY = display(0, 0, 1512, 982);
const RIGHT = display(1512, 200, 1920, 1080);
const THREE = [LEFT, PRIMARY, RIGHT];

function main() {
  console.log('');

  // -- first run -----------------------------------------------------------
  {
    // The complaint that prompted this: it opened small, on the smallest screen,
    // every time. With nothing saved it should fill the leftmost display.
    const r = ws.chooseBounds(null, THREE);
    check('first run fills the leftmost display',
      { x: r.x, y: r.y, width: r.width, height: r.height },
      { x: -2560, y: 25, width: 2560, height: 1415 });
    check('...not maximized, just sized', r.maximized, false);
    check('...and says why', /leftmost/.test(r.reason), true);

    // Leftmost by coordinate, not by list position — Electron's order is not spatial.
    const shuffled = ws.chooseBounds(null, [RIGHT, PRIMARY, LEFT]);
    check('leftmost is geometric, not the array order', shuffled.x, -2560);

    // Single display: fill it.
    const one = ws.chooseBounds(null, [PRIMARY]);
    check('one display is filled too', { x: one.x, w: one.width }, { x: 0, w: 1512 });
  }

  // -- remembering ---------------------------------------------------------
  {
    const saved = { x: -2000, y: 300, width: 1600, height: 900, maximized: false };
    const r = ws.chooseBounds(saved, THREE);
    check('a saved place on a display that still exists is restored',
      { x: r.x, y: r.y, width: r.width, height: r.height }, saved.x !== undefined
        ? { x: -2000, y: 300, width: 1600, height: 900 } : null);
    check('...reported as restored', r.reason, 'restored');

    const max = ws.chooseBounds(Object.assign({}, saved, { maximized: true }), THREE);
    check('maximized is remembered', max.maximized, true);

    // Straddling two displays is fully visible and must not be moved. Judging each
    // display separately would call this half-lost.
    const straddle = { x: -200, y: 400, width: 900, height: 600 };
    check('a window across two displays is left alone',
      ws.chooseBounds(straddle, THREE).reason, 'restored');
  }

  // -- the arrangement changed ---------------------------------------------
  {
    // The left display is gone. Its coordinates now point at nothing.
    const onGoneDisplay = { x: -2000, y: 300, width: 1600, height: 900 };
    const r = ws.chooseBounds(onGoneDisplay, [PRIMARY, RIGHT]);
    check('a saved place with no display is not used', r.reason !== 'restored', true);
    check('...it falls back to the leftmost remaining', r.x, 0);

    // Mostly off the right edge — the classic "dragged mostly off screen" case.
    const mostlyOff = { x: 3300, y: 300, width: 1200, height: 800 };
    check('mostly off-screen is rejected', ws.chooseBounds(mostlyOff, THREE).reason !== 'restored', true);

    // Just clipped is fine; nudging a window the user placed would be worse.
    const slightlyOff = { x: -2600, y: 100, width: 1200, height: 800 };
    check('slightly clipped is kept', ws.chooseBounds(slightlyOff, THREE).reason, 'restored');
  }

  // -- rubbish in the store ------------------------------------------------
  {
    // config.json is user-editable and survives upgrades, so none of this is
    // hypothetical. Every case must land somewhere visible.
    const bad = [
      undefined, null, {}, { x: 0, y: 0 }, { x: 'a', y: 0, width: 100, height: 100 },
      { x: NaN, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: -50, height: -50 },
      { x: Infinity, y: 0, width: 100, height: 100 },
    ];
    let allSane = true;
    for (const saved of bad) {
      const r = ws.chooseBounds(saved, THREE);
      const visible = ws.visibleFraction(r, THREE);
      if (!(visible >= 0.9 && r.width >= ws.MIN_SIZE.width && r.height >= ws.MIN_SIZE.height)) {
        allSane = false;
        console.log('    ' + JSON.stringify(saved) + ' → ' + JSON.stringify(r));
      }
    }
    check('every malformed saved state lands on screen at a usable size', allSane, true);

    // A saved size below the minimum is grown, not honoured — the renderer's layout
    // has a floor and below it the transport controls overlap.
    const tiny = ws.chooseBounds({ x: 10, y: 60, width: 200, height: 150 }, THREE);
    check('a too-small saved size is grown to the minimum',
      { w: tiny.width, h: tiny.height }, { w: ws.MIN_SIZE.width, h: ws.MIN_SIZE.height });
  }

  // -- no displays at all --------------------------------------------------
  {
    // Reported during sleep/wake on some machines. Must not throw or divide by zero.
    const r = ws.chooseBounds({ x: 0, y: 0, width: 1000, height: 800 }, []);
    check('no displays reported → default size, no position',
      { w: r.width, h: r.height, x: r.x }, { w: 1180, h: 780, x: undefined });
    check('visibleFraction of nothing is 0', ws.visibleFraction({ x: 0, y: 0, width: 10, height: 10 }, []), 0);
    check('...and a zero-area window is 0, not NaN',
      ws.visibleFraction({ x: 0, y: 0, width: 0, height: 0 }, THREE), 0);
  }

  // -- what gets written ---------------------------------------------------
  {
    // Normal bounds, never the maximized rectangle: saving that would restore a
    // window that cannot be un-maximized to anything sensible.
    const fake = {
      isDestroyed: () => false,
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 100, y: 200, width: 1300, height: 850 }),
      getBounds: () => ({ x: -2560, y: 25, width: 2560, height: 1415 }),
    };
    check('saves the normal bounds while maximized',
      ws.stateToSave(fake), { x: 100, y: 200, width: 1300, height: 850, maximized: true });

    const older = {
      isDestroyed: () => false,
      isMaximized: () => false,
      getBounds: () => ({ x: 5, y: 6, width: 1200, height: 800 }),
    };
    check('falls back to getBounds when getNormalBounds is absent',
      ws.stateToSave(older), { x: 5, y: 6, width: 1200, height: 800, maximized: false });

    check('a destroyed window saves nothing',
      ws.stateToSave({ isDestroyed: () => true }), null);
    check('no window saves nothing', ws.stateToSave(null), null);
  }

  // -- round trip ----------------------------------------------------------
  {
    // The property that matters in daily use: quit and reopen must not move it.
    const placed = ws.chooseBounds(null, THREE);
    const fake = {
      isDestroyed: () => false,
      isMaximized: () => false,
      getNormalBounds: () => ({ x: placed.x, y: placed.y, width: placed.width, height: placed.height }),
    };
    const saved = ws.stateToSave(fake);
    const again = ws.chooseBounds(saved, THREE);
    check('open → save → open is stable',
      { x: again.x, y: again.y, width: again.width, height: again.height },
      { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main();
