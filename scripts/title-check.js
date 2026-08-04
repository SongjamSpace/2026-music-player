#!/usr/bin/env node
'use strict';

/**
 * Checks the display-name decoding in renderer/js/util.js.
 *
 * Torrent names are attacker-supplied text that the app renders, and they arrive
 * from a magnet's `dn=`, which release sites scrape straight out of HTML — so an
 * apostrophe turns up as `&rsquo;` and shows literally. Decoding it is easy to get
 * wrong in two directions that both matter: too little and the UI shows entity
 * soup, too much and a name that legitimately contains `&amp;rsquo;` silently
 * becomes something the release is not called. Neither is visible without looking
 * at that exact release.
 *
 * The real reason this is a harness and not a comment: the tempting
 * implementation is `el.innerHTML = name; return el.textContent`, which decodes
 * everything *and* parses hostile text as HTML. These cases pin the behaviour so
 * nobody swaps in the short version later.
 *
 * Evaluates the real module against a stub rather than copying the rule, the way
 * album-grouping-check.js does — a copy in the test would only verify itself.
 *
 *   node scripts/title-check.js
 */

const fs = require('fs');
const path = require('path');

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(52) +
      (ok ? JSON.stringify(actual) : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  );
}

function loadUtil() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'util.js'), 'utf8');
  const win = { MP: {} };
  new Function('window', 'document', src)(win, {
    createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {} }),
  });
  if (!win.MP.util || typeof win.MP.util.decodeEntities !== 'function') {
    throw new Error('renderer/js/util.js did not export decodeEntities');
  }
  return win.MP.util;
}

function main() {
  const util = loadUtil();
  const d = util.decodeEntities;
  console.log('');

  // -- the reported case ---------------------------------------------------
  check(
    'the release that reported this',
    d('Animal Collective - Isn&rsquo;t It Now? (2023) Mp3 320kbps [PMEDIA] ⭐️'),
    'Animal Collective - Isn’t It Now? (2023) Mp3 320kbps [PMEDIA] ⭐️'
  );

  // -- named entities ------------------------------------------------------
  check('curly quotes', d('&ldquo;Heroes&rdquo;'), '“Heroes”');
  check('dashes and ellipsis', d('A&ndash;B&mdash;C&hellip;'), 'A–B—C…');
  check('ampersand', d('Simon &amp; Garfunkel'), 'Simon & Garfunkel');
  check('case-insensitive', d('Isn&RSQUO;t'), 'Isn’t');

  // -- numeric entities ----------------------------------------------------
  check('decimal', d('Isn&#8217;t'), 'Isn’t');
  check('hex, lower x', d('Isn&#x2019;t'), 'Isn’t');
  check('hex, upper X', d('Isn&#X2019;t'), 'Isn’t');
  check('astral plane (beyond BMP)', d('&#128512;'), '\u{1F600}');

  // -- left alone ----------------------------------------------------------
  // Everything below is either not an entity or not one we know. Leaving it
  // untouched is the safe direction: an undecoded entity is ugly, a wrong guess
  // renames someone's release.
  check('a bare ampersand', d('AT&T'), 'AT&T');
  check('an unknown entity', d('&notanentity;'), '&notanentity;');
  check('an unterminated entity', d('Isn&rsquo t'), 'Isn&rsquo t');
  check('an empty numeric entity', d('&#;'), '&#;');
  check('a lone surrogate is refused', d('&#xD800;'), '&#xD800;');
  check('a control character is refused', d('&#0;'), '&#0;');
  check('out of Unicode range is refused', d('&#1114112;'), '&#1114112;');
  check('no ampersand at all is returned as-is', d('Plain Title'), 'Plain Title');

  // Single left-to-right pass: `&amp;` is consumed first and the scan resumes
  // after it, so an escaped entity stays escaped instead of being decoded twice.
  check('an escaped entity decodes exactly once', d('Isn&amp;rsquo;t'), 'Isn&rsquo;t');

  // -- not markup ----------------------------------------------------------
  // These are why this is a table and not innerHTML. Decoding must never build a
  // node from a torrent name.
  check(
    'a script tag comes back as inert text',
    d('&lt;script&gt;alert(1)&lt;/script&gt;'),
    '<script>alert(1)</script>'
  );
  check('an img onerror is not parsed', d('&lt;img src=x onerror=y&gt;'), '<img src=x onerror=y>');

  // -- types ---------------------------------------------------------------
  check('null passes through', d(null), null);
  check('undefined passes through', d(undefined), undefined);

  // -- the magnet path, end to end -----------------------------------------
  const magnet =
    'magnet:?xt=urn:btih:' + 'a'.repeat(40) +
    '&dn=Animal+Collective+-+Isn%26rsquo%3Bt+It+Now%3F+%282023%29';
  check(
    'parseDisplayName decodes the dn it extracts',
    util.parseDisplayName(magnet),
    'Animal Collective - Isn’t It Now? (2023)'
  );

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main();
