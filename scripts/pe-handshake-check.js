#!/usr/bin/env node
'use strict';

/**
 * Proves the encrypted-handshake freeze, and that the patch fixes it.
 *
 * The bug, in one sentence: receiving an MSE/PE handshake for an info hash we
 * do not have permanently locks the main thread at 100% CPU.
 *
 *   conn-pool.js onPe3()        no matching torrent -> peer.destroy(), and
 *                               crucially never calls sendPe4()
 *   sendPe4() -> setEncrypt()   the only thing that sets `_setGenerators`
 *   bittorrent-protocol :1178   while (!this._setGenerators) {}
 *
 * Because that is a busy-wait on a single-threaded event loop, the only code
 * that could set the flag is precisely the code the loop prevents from running.
 * It never exits. Same shape at :1164 on the outgoing path.
 *
 * Invisible in ordinary testing: it needs an *incoming* encrypted connection
 * carrying an info hash the client isn't serving. Before port forwarding
 * started working there were almost no incoming connections at all, which is
 * why this app ran for months without hitting it. On a forwarded port it is
 * routine — stale DHT entries for removed torrents, swarm crawlers, old
 * tracker announces.
 *
 * Structure: the observer must not do any torrenting itself, because either
 * side can be the one that freezes and a frozen observer cannot report. So the
 * parent only watches, and both participants run as children that heartbeat.
 *
 *   node scripts/pe-handshake-check.js
 */

const { fork } = require('child_process');
const crypto = require('crypto');

const PORT = 51999;
const HEARTBEAT_MS = 100;
const STALL_MS = 3000; // ~30 missed beats; no GC pause comes close
const RUN_MS = 15000;

const beat = () => {
  setInterval(() => {
    try {
      process.send({ beat: Date.now() });
    } catch (_) {
      /* parent gone */
    }
  }, HEARTBEAT_MS).unref();
};

// -- victim: the app's shape. Secure, listening, holding a torrent ------------

if (process.env.MP_PE_ROLE === 'victim') {
  const WebTorrent = require('webtorrent');
  const client = new WebTorrent({ secure: true, torrentPort: PORT, dhtPort: PORT + 1, utp: false });
  client.on('error', () => {});
  beat();
  client.seed(Buffer.from('pe-handshake-check'), { name: 'probe.bin', announce: [] }, () => {
    process.send({ ready: true });
  });
  setTimeout(() => process.exit(0), RUN_MS + 5000).unref();
  return;
}

// -- attacker: asks for an info hash the victim does not have -----------------

if (process.env.MP_PE_ROLE === 'attacker') {
  const WebTorrent = require('webtorrent');
  const client = new WebTorrent({ secure: true, torrentPort: 0, dhtPort: 0, utp: false });
  client.on('error', () => {});
  beat();
  const infoHash = crypto.randomBytes(20).toString('hex');
  const t = client.add('magnet:?xt=urn:btih:' + infoHash, {
    announce: [],
    store: require('memory-chunk-store'),
  });
  t.on('error', () => {});
  process.send({ ready: true, infoHash });
  // One connection is enough; retrying removes any dependence on a single
  // handshake winning a race.
  setInterval(() => {
    try {
      t.addPeer('127.0.0.1:' + PORT);
    } catch (_) {}
  }, 400).unref();
  setTimeout(() => process.exit(0), RUN_MS + 5000).unref();
  return;
}

// -- observer: no torrent code at all, so it cannot be the one that freezes ---

function spawn(role) {
  const child = fork(__filename, [], {
    env: Object.assign({}, process.env, { MP_PE_ROLE: role }),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const state = { role, child, last: Date.now(), ready: false, info: null };
  child.on('message', (m) => {
    if (m.beat) state.last = m.beat;
    if (m.ready) {
      state.ready = true;
      state.info = m.infoHash || null;
    }
  });
  // A child that dies is not a hang, but it is not a pass either.
  child.on('exit', (code, sig) => {
    if (!done) state.exited = sig || code;
  });
  return state;
}

let done = false;
const victim = spawn('victim');
let attacker = null;

function finish(ok, detail) {
  if (done) return;
  done = true;
  [victim, attacker].forEach((s) => {
    if (s && s.child) {
      try {
        s.child.kill('SIGKILL');
      } catch (_) {}
    }
  });
  console.log('');
  console.log((ok ? '  PASS  ' : '  FAIL  ') + detail);
  console.log('\n' + (ok ? 'all checks passed' : '1 FAILED') + '\n');
  process.exit(ok ? 0 : 1);
}

const untilReady = setInterval(() => {
  if (!victim.ready) return;
  clearInterval(untilReady);
  attacker = spawn('attacker');
  console.log('\n  victim seeding on :' + PORT + ' — dialling it with an info hash it does not have');

  const started = Date.now();
  setInterval(() => {
    const now = Date.now();
    for (const s of [victim, attacker]) {
      if (!s || !s.ready) continue;
      const stalled = now - s.last;
      if (stalled > STALL_MS) {
        finish(
          false,
          'the ' + s.role + " process froze — no heartbeat for " + stalled + 'ms after an\n' +
            '        inbound encrypted handshake for an unknown info hash. This is the\n' +
            '        busy-wait at bittorrent-protocol/index.js:1178.\n' +
            '        Fix: node scripts/patch-deps.js'
        );
      }
      if (s.exited) {
        finish(false, 'the ' + s.role + ' process exited unexpectedly (' + s.exited + ')');
      }
    }
    if (now - started > RUN_MS) {
      finish(
        true,
        'both processes stayed responsive through repeated inbound encrypted\n' +
          '        handshakes for an unknown info hash'
      );
    }
  }, 200);
}, 100);

setTimeout(() => finish(false, 'victim never finished seeding — test harness problem, not a result'), 30000);
