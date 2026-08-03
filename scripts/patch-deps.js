#!/usr/bin/env node
'use strict';

/**
 * Patches two busy-wait loops in bittorrent-protocol that freeze the app.
 *
 * Upstream, both the incoming and outgoing MSE/PE handshake paths do this:
 *
 *     this._onPe3(buffer)
 *     while (!this._setGenerators) {
 *       // Wait until generators have been set
 *     }
 *     this._parsePe3Encrypted()
 *
 * `_setGenerators` is set in exactly one place — setEncrypt() — which is only
 * reached synchronously, via sendPe4()/sendPe3(), from the handler for the
 * 'pe3'/'pe2' event that `_onPe3`/`_onPe2` just emitted. So on the happy path
 * the flag is already true and the loop body never runs.
 *
 * When the handler declines to respond, it can never become true. webtorrent's
 * conn-pool does exactly that: an incoming peer whose info hash matches no
 * torrent is destroyed without calling sendPe4()
 * (webtorrent/lib/conn-pool.js, onPe3). Control returns here, and a busy-wait
 * on a single-threaded event loop blocks the only code that could ever set the
 * flag. The result is a permanent 100% CPU freeze of the whole main process —
 * no crash, no log, just a dead app.
 *
 * That needs an *inbound* encrypted connection for an info hash we don't have:
 * a stale DHT entry for a removed torrent, a swarm crawler, an old tracker
 * announce. Rare without port forwarding, routine with it.
 *
 * Replaced with a guard that tears the connection down instead. Setting the
 * parser to MAX_VALUE first is the library's own idiom for halting _write()'s
 * drain loop (see _onFinish) — it does not depend on 'finish' being emitted
 * synchronously by destroy().
 *
 * Idempotent, and exact-match: if a dependency upgrade changes this code the
 * script fails loudly rather than silently leaving the app unpatched.
 *
 *   node scripts/patch-deps.js
 *   node scripts/patch-deps.js --check   # verify only, exit 1 if unpatched
 */

const fs = require('fs');
const path = require('path');

const MARK = 'MP-PATCH: busy-wait removed';

const TARGET = path.join(__dirname, '..', 'node_modules', 'bittorrent-protocol', 'index.js');

function guard(after, next) {
  return (
    `      ${after}\n` +
    `      // ${MARK} — see scripts/patch-deps.js.\n` +
    `      // Upstream spins here on \`while (!this._setGenerators) {}\`. That flag is\n` +
    `      // only set synchronously by the handler for the event just emitted above;\n` +
    `      // when the handler declines to answer (webtorrent's conn-pool destroys an\n` +
    `      // incoming peer whose info hash matches no torrent) it can never be set,\n` +
    `      // and the spin blocks the event loop that would have to set it. Freeze.\n` +
    `      if (!this._setGenerators) {\n` +
    `        this._parse(Number.MAX_VALUE, () => {}) // halt _write()'s drain loop\n` +
    `        this.destroy()\n` +
    `        return\n` +
    `      }\n` +
    `      ${next}`
  );
}

/** [description, exact text to find, replacement]. */
const EDITS = [
  [
    '_parsePe2 (outgoing handshake)',
    '      this._onPe2(pubKey)\n' +
      '      while (!this._setGenerators) {\n' +
      '        // Wait until generators have been set\n' +
      '      }\n' +
      '      this._parsePe4()',
    guard('this._onPe2(pubKey)', 'this._parsePe4()'),
  ],
  [
    '_parsePe3 (incoming handshake — the one that froze the app)',
    '      this._onPe3(buffer)\n' +
      '      while (!this._setGenerators) {\n' +
      '        // Wait until generators have been set\n' +
      '      }\n' +
      '      this._parsePe3Encrypted()',
    guard('this._onPe3(buffer)', 'this._parsePe3Encrypted()'),
  ],
];

function main() {
  const checkOnly = process.argv.includes('--check');

  let src;
  try {
    src = fs.readFileSync(TARGET, 'utf8');
  } catch (err) {
    console.error('patch-deps: cannot read ' + TARGET);
    console.error('  run npm install first');
    process.exit(1);
  }

  const already = src.split(MARK).length - 1;
  if (already === EDITS.length) {
    console.log('patch-deps: bittorrent-protocol already patched (' + already + '/' + EDITS.length + ')');
    return;
  }
  if (checkOnly) {
    console.error('patch-deps: NOT patched (' + already + '/' + EDITS.length + ') — run: node scripts/patch-deps.js');
    process.exit(1);
  }

  let out = src;
  const applied = [];
  for (const [label, find, replace] of EDITS) {
    const hits = out.split(find).length - 1;
    if (hits === 0) {
      console.error('patch-deps: could not find the busy-wait in ' + label + '.');
      console.error('  bittorrent-protocol has changed. Re-check upstream before shipping —');
      console.error('  an unpatched build freezes on any inbound encrypted handshake for an');
      console.error('  info hash this client does not have.');
      process.exit(1);
    }
    if (hits > 1) {
      console.error('patch-deps: ' + label + ' matched ' + hits + ' times; refusing to guess.');
      process.exit(1);
    }
    out = out.replace(find, replace);
    applied.push(label);
  }

  fs.writeFileSync(TARGET, out);
  console.log('patch-deps: patched bittorrent-protocol@' + version() + ':');
  applied.forEach((l) => console.log('  · ' + l));
}

function version() {
  try {
    return require('bittorrent-protocol/package.json').version;
  } catch (_) {
    return '?';
  }
}

main();
