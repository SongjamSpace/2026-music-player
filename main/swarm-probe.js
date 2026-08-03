/**
 * How much of a swarm can we actually reach?
 *
 * This exists because "0 B/s with 9 seeders" is not a contradiction and the app
 * had no way to say so. Download speed turns out to track exactly one number —
 * the fraction of a swarm that will accept a connection from us — and nothing
 * else. Measured on this machine, across four orders of magnitude:
 *
 *   Ubuntu     75 seeders, 60 addresses,  9 dialable (23%)  ->  25-35 MB/s
 *   Daft Punk  50 seeders, 45 addresses,  3 dialable ( 8%)  ->  3.4 MB/s
 *   GTA V       5 seeders,  4 addresses,  1 dialable (25%)  ->  completed, 2.3 GB
 *   Kill Bill   9 seeders, 48 addresses,  0 dialable        ->  frozen at 23%
 *
 * Seeder count says nothing. A swarm of residential peers behind NAT is
 * unreachable to another peer behind NAT, and the only cure is an open port on
 * one side. So when a torrent sits at zero this answers the actual question:
 * is nobody there, or is nobody reachable — and is that their fault or ours?
 *
 * Strictly on demand. It opens real TCP connections to real peers, so it runs
 * when the user presses the button and at no other time.
 */

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

// BEP15 magic protocol id for the connect handshake.
const PROTOCOL_ID = Buffer.from('0000041727101980', 'hex');
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;

const TRACKER_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 7000;
const MAX_TRACKERS = 6;
const DEFAULT_SAMPLE = 30;

function parseUdpTracker(url) {
  const m = /^udp:\/\/([^:/]+):(\d+)/i.exec(url);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

/**
 * One BEP15 announce: connect handshake, then announce, then parse the compact
 * peer list.
 *
 * Two details here are easy to get wrong and produce a convincing-looking
 * "empty swarm": `left` must be non-zero or many trackers decline to return
 * seeders at all, and `num_want` sits at byte 92 of the announce packet — get
 * its offset wrong and you silently receive the default handful instead of the
 * full list.
 */
function announce(host, port, infoHash) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const transactionId = crypto.randomBytes(4);
    const peerId = crypto.randomBytes(20);
    const hash = Buffer.from(infoHash, 'hex');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout', peers: [] }), TRACKER_TIMEOUT_MS);

    socket.on('error', (err) => finish({ ok: false, error: err.code || err.message, peers: [] }));

    socket.on('message', (msg) => {
      // A message can land in the same turn the timeout fires and closes the
      // socket; sending on a closed dgram socket throws synchronously, and a
      // throw inside an event handler is uncaught and would end the process.
      if (settled) return;
      if (msg.length >= 16 && msg.readUInt32BE(0) === ACTION_CONNECT) {
        const req = Buffer.concat([
          msg.slice(8, 16), // connection id
          Buffer.from([0, 0, 0, ACTION_ANNOUNCE]),
          transactionId,
          hash,
          peerId,
          Buffer.alloc(8), // downloaded
          // left: deliberately non-zero. Announce as a completed peer and many
          // trackers return only leechers, which reads as a dead swarm.
          Buffer.from('00000000ffffffff', 'hex'),
          Buffer.alloc(8), // uploaded
          Buffer.alloc(4), // event: none
          Buffer.alloc(4), // ip: default
          Buffer.alloc(4), // key
          Buffer.from([255, 255, 255, 255]), // num_want: -1 = as many as you have
          Buffer.from([0x1a, 0xe1]), // port 6881
        ]);
        try {
          socket.send(req, port, host);
        } catch (err) {
          finish({ ok: false, error: err.code || err.message, peers: [] });
        }
        return;
      }
      if (msg.length >= 20 && msg.readUInt32BE(0) === ACTION_ANNOUNCE) {
        const peers = [];
        for (let i = 20; i + 6 <= msg.length; i += 6) {
          peers.push({
            host: msg[i] + '.' + msg[i + 1] + '.' + msg[i + 2] + '.' + msg[i + 3],
            port: msg.readUInt16BE(i + 4),
          });
        }
        finish({
          ok: true,
          leechers: msg.readUInt32BE(12),
          seeders: msg.readUInt32BE(16),
          peers,
        });
      }
    });

    const connectReq = Buffer.concat([PROTOCOL_ID, Buffer.from([0, 0, 0, ACTION_CONNECT]), transactionId]);
    socket.send(connectReq, port, host, (err) => {
      if (err) finish({ ok: false, error: err.code || err.message, peers: [] });
    });
  });
}

/**
 * Can we open a TCP connection to this peer?
 *
 * ECONNREFUSED counts as reachable on purpose: something answered, so the host
 * is alive and routable and only this port is shut. Silence is the interesting
 * case — that is a peer we can never trade with.
 */
function dial(host, port) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable, code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, reachable, code, ms: Date.now() - startedAt });
    };
    socket.setTimeout(PEER_TIMEOUT_MS, () => finish(false, 'TIMEOUT'));
    socket.once('error', (err) => finish(err.code === 'ECONNREFUSED', err.code || 'ERR'));
    socket.once('connect', () => finish(true, 'OK'));
    socket.connect(port, host);
  });
}

/**
 * @param {string} infoHash  40-hex.
 * @param {object} opts
 * @param {string[]} opts.trackers  Announce URLs; only udp:// are used.
 * @param {Array<{host,port}>=} opts.knownPeers  Wires already connected, folded in.
 */
async function probe(infoHash, { trackers = [], knownPeers = [], sample = DEFAULT_SAMPLE } = {}) {
  const udp = trackers.map(parseUdpTracker).filter(Boolean).slice(0, MAX_TRACKERS);
  const results = await Promise.all(udp.map((t) => announce(t.host, t.port, infoHash)));

  const addresses = new Map();
  let seeders = 0;
  let leechers = 0;
  let trackersOk = 0;

  results.forEach((r) => {
    if (!r.ok) return;
    trackersOk++;
    // Trackers disagree on swarm size; the largest is the least wrong, since
    // each only knows the peers that announced to it.
    seeders = Math.max(seeders, r.seeders || 0);
    leechers = Math.max(leechers, r.leechers || 0);
    r.peers.forEach((p) => addresses.set(p.host + ':' + p.port, p));
  });
  knownPeers.forEach((p) => {
    if (p && p.host && p.port) addresses.set(p.host + ':' + p.port, p);
  });

  const list = [...addresses.values()];
  const chosen = list.slice(0, sample);
  const dialed = await Promise.all(chosen.map((p) => dial(p.host, p.port)));
  const dialable = dialed.filter((d) => d.reachable);

  return {
    at: Date.now(),
    seeders,
    leechers,
    trackersOk,
    trackersTried: udp.length,
    addresses: list.length,
    sampled: chosen.length,
    dialable: dialable.length,
    timedOut: dialed.filter((d) => d.code === 'TIMEOUT').length,
    refused: dialed.filter((d) => d.code === 'ECONNREFUSED').length,
    fastest: dialable.length ? Math.min(...dialable.map((d) => d.ms)) : null,
  };
}

module.exports = { probe };
