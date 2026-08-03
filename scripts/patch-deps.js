#!/usr/bin/env node
'use strict';

/**
 * Patches bugs in the webtorrent dependency tree that break this app.
 *
 * Every patch here is exact-match and idempotent: if a dependency upgrade changes
 * the code being patched, the script fails loudly rather than silently leaving the
 * app broken.
 *
 *   node scripts/patch-deps.js
 *   node scripts/patch-deps.js --check   # verify only, exit 1 if unpatched
 *
 * -- 1. bittorrent-protocol: two busy-wait loops that freeze the app -----------
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
 * -- 2. webtorrent rarity-map: throws during shutdown --------------------------
 *
 * `RarityMap.destroy()` cleans up each wire and then nulls all of its own state:
 *
 *     this._torrent.wires.forEach(wire => { this._cleanupWireEvents(wire) })
 *     this._torrent = null
 *     this._pieces = null
 *     this._onWireHave = null
 *     this._onWireBitfield = null
 *
 * But every wire also carries a `once('close')` handler, installed by
 * `_initWire`, which uses that state. Wires close *after* destroy() during
 * teardown, so the handler runs against a fully-nulled map and throws. Observed
 * on every quit:
 *
 *     [shutdown] torrent teardown: TypeError [ERR_INVALID_ARG_TYPE] …
 *       at RarityMap._cleanupWireEvents (rarity-map.js:101)
 *       at wire._onClose (rarity-map.js:76)
 *       at Wire.destroy (bittorrent-protocol/index.js:191)
 *       at Torrent.removePeer (webtorrent/lib/torrent.js:958)
 *
 * The throw escapes into `torrentService.destroy()` and aborts teardown partway,
 * so the remaining torrents are never cleanly destroyed and their stores never
 * flushed — on an app whose data lives on an external drive.
 *
 * The guard belongs in `_onClose`, not in `_cleanupWireEvents`. Guarding only the
 * listener removal was tried first and was not enough: it moved the failure one
 * line down to `this._pieces[i] -= …`, which is null for the same reason. Bailing
 * out of the whole handler covers both, and is correct — there is nothing
 * meaningful for a destroyed availability map to do when a wire closes.
 * `_cleanupWireEvents` called directly from destroy() is unaffected, because at
 * that point the handlers have not been nulled yet.
 */

const fs = require('fs');
const path = require('path');

const MARK = 'MP-PATCH';

function dep() {
  return path.join(__dirname, '..', 'node_modules');
}

function busyWaitGuard(after, next) {
  return (
    `      ${after}\n` +
    `      // ${MARK}: busy-wait removed — see scripts/patch-deps.js.\n` +
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

/**
 * One entry per file, each with its own exact-match edits.
 *
 * `expected` is the number of MARK occurrences a fully patched file has, so the
 * --check path can tell "patched" from "half patched" without re-matching.
 */
const TARGETS = [
  {
    label: 'bittorrent-protocol',
    file: path.join(dep(), 'bittorrent-protocol', 'index.js'),
    pkg: 'bittorrent-protocol/package.json',
    unpatchedConsequence:
      'an unpatched build freezes at 100% CPU on any inbound encrypted handshake\n' +
      '  for an info hash this client does not have.',
    edits: [
      [
        '_parsePe2 (outgoing handshake)',
        '      this._onPe2(pubKey)\n' +
          '      while (!this._setGenerators) {\n' +
          '        // Wait until generators have been set\n' +
          '      }\n' +
          '      this._parsePe4()',
        busyWaitGuard('this._onPe2(pubKey)', 'this._parsePe4()'),
      ],
      [
        '_parsePe3 (incoming handshake — the one that froze the app)',
        '      this._onPe3(buffer)\n' +
          '      while (!this._setGenerators) {\n' +
          '        // Wait until generators have been set\n' +
          '      }\n' +
          '      this._parsePe3Encrypted()',
        busyWaitGuard('this._onPe3(buffer)', 'this._parsePe3Encrypted()'),
      ],
    ],
  },
  {
    label: 'webtorrent rarity-map',
    file: path.join(dep(), 'webtorrent', 'lib', 'rarity-map.js'),
    pkg: 'webtorrent/package.json',
    unpatchedConsequence:
      'an unpatched build throws during shutdown and aborts torrent teardown,\n' +
      '  leaving stores unflushed.',
    edits: [
      [
        "_initWire's close handler (runs after destroy() has nulled everything)",
        '    wire._onClose = () => {\n' +
          '      this._cleanupWireEvents(wire)',
        '    wire._onClose = () => {\n' +
          `      // ${MARK}: post-destroy guard — see scripts/patch-deps.js.\n` +
          '      // destroy() nulls _pieces and the shared handlers, and wires only close\n' +
          '      // afterwards during teardown. Unguarded, this handler then throws — first\n' +
          '      // on removeListener(_, null) and then on _pieces[i] — and the throw aborts\n' +
          '      // the whole torrent teardown. A destroyed availability map has nothing to\n' +
          '      // update, so bail.\n' +
          '      if (!this._pieces) return\n' +
          '      this._cleanupWireEvents(wire)',
      ],
    ],
  },
];

function version(pkg) {
  try {
    return require(pkg).version;
  } catch (_) {
    return '?';
  }
}

function patchOne(target, checkOnly) {
  let src;
  try {
    src = fs.readFileSync(target.file, 'utf8');
  } catch (err) {
    console.error('patch-deps: cannot read ' + target.file);
    console.error('  run npm install first');
    process.exit(1);
  }

  const already = src.split(MARK).length - 1;
  const expected = target.edits.length;

  if (already === expected) {
    console.log(
      'patch-deps: ' + target.label + ' already patched (' + already + '/' + expected + ')'
    );
    return;
  }
  if (checkOnly) {
    console.error(
      'patch-deps: ' + target.label + ' NOT patched (' + already + '/' + expected + ')' +
        ' — run: node scripts/patch-deps.js'
    );
    process.exit(1);
  }

  let out = src;
  const applied = [];
  for (const [label, find, replace] of target.edits) {
    const hits = out.split(find).length - 1;
    if (hits === 0) {
      console.error('patch-deps: could not find the target code in ' + label + '.');
      console.error('  ' + target.label + ' has changed. Re-check upstream before shipping —');
      console.error('  ' + target.unpatchedConsequence);
      process.exit(1);
    }
    if (hits > 1) {
      console.error('patch-deps: ' + label + ' matched ' + hits + ' times; refusing to guess.');
      process.exit(1);
    }
    out = out.replace(find, replace);
    applied.push(label);
  }

  fs.writeFileSync(target.file, out);
  console.log('patch-deps: patched ' + target.label + '@' + version(target.pkg) + ':');
  applied.forEach((l) => console.log('  · ' + l));
}

function main() {
  const checkOnly = process.argv.includes('--check');
  for (const target of TARGETS) patchOne(target, checkOnly);
}

main();
