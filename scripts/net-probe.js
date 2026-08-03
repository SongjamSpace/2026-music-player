#!/usr/bin/env node
'use strict';

/**
 * Torrent throughput probe.
 *
 * Exists because `torrent.downloadSpeed` — the number the app displays — is a
 * five-second EMA of raw wire bytes (including duplicate and discarded blocks),
 * so it is not a metric you can tune against. This measures the only thing that
 * matters: bytes actually verified to disk over a fixed window, after a warmup
 * long enough for the swarm to ramp.
 *
 * Runs standalone against the app's own webtorrent copy and writes to a scratch
 * dir under os.tmpdir(). It never touches the user's library or config.
 *
 *   node scripts/net-probe.js --torrent ubuntu --duration 180 --warmup 30
 *   node scripts/net-probe.js --torrent baseline-check --profile baseline
 *   node scripts/net-probe.js --torrent 'magnet:?xt=...' --strategy rarest --port 51820
 *
 * A/B protocol: alternate profiles A/B/A/B/A/B rather than running all of A then
 * all of B. Swarm population and ISP conditions drift over tens of minutes and
 * will otherwise be attributed to your change.
 */

const TEARDOWN_TIMEOUT_MS = 5000;

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const WebTorrent = require('webtorrent');
const { createTrackers } = require('../main/trackers');

// -- presets ---------------------------------------------------------------
//
// Three torrents, because "too slow" has three different causes and a single
// reference can't tell them apart.

const PRESETS = {
  // Thousands of seeds. The line-rate probe: if this doesn't saturate your
  // connection, the bottleneck is local (client options, main-thread CPU,
  // disk) and no amount of peer discovery will help.
  ubuntu: { resolve: resolveUbuntuTorrent, note: 'huge swarm — line-rate probe' },

  // Public-domain Grateful Dead soundboard on archive.org, which serves HTTP
  // web seeds. Isolates maxWebConns; also the closest reference to the app's
  // real workload (an album of audio files).
  archive: {
    url: 'https://archive.org/download/gd1977-05-08.shure57.stevenson.29303.flac16/gd1977-05-08.shure57.stevenson.29303.flac16_archive.torrent',
    note: 'HTTP web seeds — isolates maxWebConns',
  },
};

/**
 * Ubuntu publishes .torrent files but no stable magnet, and the filename
 * carries a point release that moves every few months. Scrape it rather than
 * hardcoding a URL that silently 404s six months from now.
 */
async function resolveUbuntuTorrent() {
  const index = await fetchText('https://releases.ubuntu.com/');
  const dirs = [...index.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\/"/g)].map((m) => m[1]);
  if (!dirs.length) throw new Error('could not parse releases.ubuntu.com index');

  // Newest first, so a fresh release is picked up automatically.
  dirs.sort(compareVersionsDesc);

  for (const dir of dirs) {
    let listing;
    try {
      listing = await fetchText('https://releases.ubuntu.com/' + dir + '/');
    } catch (_) {
      continue;
    }
    const files = [...listing.matchAll(/href="(ubuntu-[\d.]+-desktop-amd64\.iso\.torrent)"/g)].map((m) => m[1]);
    if (!files.length) continue;
    files.sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)));
    return 'https://releases.ubuntu.com/' + dir + '/' + files[0];
  }
  throw new Error('no desktop-amd64 torrent found on releases.ubuntu.com');
}

function versionOf(name) {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(name);
  return m ? m[1] : '0';
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' → HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// -- args ------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    torrent: 'ubuntu',
    duration: 180,
    warmup: 30,
    profile: 'tuned',
    strategy: null, // null = profile default
    port: null,
    trackers: null,
    nat: null,
    maxConns: null,
    uploadLimit: null,
    keep: false,
    csv: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i];
    switch (key) {
      case '--torrent': args.torrent = next(); break;
      case '--duration': args.duration = Number(next()); break;
      case '--warmup': args.warmup = Number(next()); break;
      case '--profile': args.profile = next(); break;
      case '--strategy': args.strategy = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--trackers': args.trackers = next() === 'on'; break;
      case '--nat': args.nat = next() === 'on'; break;
      case '--max-conns': args.maxConns = Number(next()); break;
      case '--upload-limit': args.uploadLimit = Number(next()); break;
      case '--keep': args.keep = true; break;
      case '--no-csv': args.csv = false; break;
      case '--help':
      case '-h': usage(); process.exit(0); break;
      default:
        console.error('unknown flag: ' + key);
        usage();
        process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.error(`
net-probe — measure real torrent download throughput

  --torrent <preset|magnet|url>  ${Object.keys(PRESETS).join(' | ')} | magnet:?... | https://….torrent
  --duration <s>                 measurement window after warmup (default 180)
  --warmup <s>                   discarded ramp-up period (default 30)
  --profile baseline|tuned       baseline reproduces the app's original zero-option client
  --strategy sequential|rarest   overrides the profile default
  --port <n>                     fixed torrent port; 0 for ephemeral
  --trackers on|off              merge the default announce list
  --nat on|off                   attempt UPnP/NAT-PMP port mapping
  --max-conns <n>                per-torrent connection cap
  --upload-limit <bytes/s>       -1 for unlimited
  --keep                         don't delete the scratch download dir
  --no-csv                       summary only

Presets:
${Object.entries(PRESETS).map(([k, v]) => `  ${k.padEnd(10)} ${v.note}`).join('\n')}
`);
}

// Reproduces the app as it shipped before any tuning, so an A/B is against the
// real prior behaviour rather than against a guess at it.
const PROFILES = {
  baseline: { maxConns: 55, port: 0, trackers: false, nat: false, strategy: 'sequential', uploadLimit: -1, maxWebConns: 4, uploads: 10, storeCacheSlots: 20 },
  tuned:    { maxConns: 120, port: null, trackers: true, nat: true, strategy: 'sequential', uploadLimit: 1500000, maxWebConns: 10, uploads: 14, storeCacheSlots: 64 },
};

// -- formatting ------------------------------------------------------------

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Clamped at both ends — a sub-1 B/s trickle yields a negative exponent.
  const i = Math.max(0, Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1));
  return (n / Math.pow(1024, i)).toFixed(i ? 2 : 0) + ' ' + units[i];
}

const fmtRate = (n) => fmtBytes(n) + '/s';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

// -- peer classification ---------------------------------------------------
//
// bittorrent-protocol tags each wire with how it was established. This is the
// only trustworthy proof that inbound connectivity actually works — a router
// will happily ACK a UPnP mapping it never installed.

function classifyPeers(torrent) {
  const out = { total: 0, seeds: 0, inbound: 0, tcp: 0, utp: 0, webseed: 0, unchoked: 0 };
  for (const wire of torrent.wires || []) {
    out.total++;
    if (wire.isSeeder) out.seeds++;
    if (/Incoming$/.test(wire.type || '')) out.inbound++;
    if (/^tcp/.test(wire.type || '')) out.tcp++;
    else if (/^utp/.test(wire.type || '')) out.utp++;
    else if (wire.type === 'webSeed') out.webseed++;
    if (!wire.peerChoking) out.unchoked++;
  }
  return out;
}

const countCritical = (t) => (Array.isArray(t._critical) ? t._critical.reduce((n, v) => n + (v ? 1 : 0), 0) : 0);

// -- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const profile = PROFILES[args.profile];
  if (!profile) {
    console.error('unknown profile: ' + args.profile);
    process.exit(2);
  }

  // Explicit flags beat the profile; the profile beats nothing.
  const pick = (flag, key) => (flag !== null && flag !== undefined ? flag : profile[key]);
  const cfg = {
    maxConns: pick(args.maxConns, 'maxConns'),
    port: pick(args.port, 'port'),
    trackers: pick(args.trackers, 'trackers'),
    nat: pick(args.nat, 'nat'),
    strategy: pick(args.strategy, 'strategy'),
    uploadLimit: pick(args.uploadLimit, 'uploadLimit'),
    maxWebConns: profile.maxWebConns,
    uploads: profile.uploads,
    storeCacheSlots: profile.storeCacheSlots,
  };
  // A null port here means "tuned profile, no explicit port" — pick a stable
  // high port the way the app does, rather than falling back to ephemeral.
  if (cfg.port === null) cfg.port = 49160 + Math.floor(Math.random() * 15000);

  const preset = PRESETS[args.torrent];
  const source = preset ? (preset.url || (await preset.resolve())) : args.torrent;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-net-probe-'));

  let announce = [];
  if (cfg.trackers) {
    const trackers = createTrackers({ cacheDir: scratch, log: () => {} });
    await trackers.refresh();
    announce = trackers.list();
  }

  let nat = null;
  if (cfg.nat) {
    try {
      nat = require('../main/nat');
      await nat.open({ torrentPort: cfg.port, dhtPort: cfg.port + 1 });
    } catch (err) {
      console.error('# NAT mapping unavailable (' + err.message + ') — continuing without it');
      nat = null;
    }
  }

  console.error('# source     ' + source);
  console.error('# profile    ' + args.profile);
  console.error('# config     ' + JSON.stringify(cfg));
  console.error('# trackers   ' + announce.length);
  console.error('# nat        ' + (nat ? JSON.stringify(nat.status()) : 'off'));
  console.error('# scratch    ' + scratch);
  console.error('# window     ' + args.warmup + 's warmup + ' + args.duration + 's measured');

  const client = new WebTorrent({
    maxConns: cfg.maxConns,
    torrentPort: cfg.port,
    dhtPort: cfg.port + 1,
    utp: true,
    downloadLimit: -1,
    uploadLimit: cfg.uploadLimit,
  });
  client.on('error', (err) => console.error('# client error: ' + err.message));

  const torrent = client.add(source, {
    path: scratch,
    strategy: cfg.strategy,
    maxWebConns: cfg.maxWebConns,
    uploads: cfg.uploads,
    storeCacheSlots: cfg.storeCacheSlots,
    announce,
  });
  torrent.on('error', (err) => console.error('# torrent error: ' + err.message));
  torrent.on('warning', () => {}); // tracker timeouts are routine and very loud

  const samples = [];
  let t = 0;
  let firstByteAt = null;
  let tenMegAt = null;
  let warmupBytes = null;
  let peakInbound = 0;
  let peakPeers = 0;

  if (args.csv) {
    console.log('t,bytesDownloaded,downSpeed,peers,inbound,seeds,tcp,utp,webseed,unchoked,selections,criticalCount');
  }

  const total = args.warmup + args.duration;
  const startedAt = Date.now();

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      t = Math.round((Date.now() - startedAt) / 1000);
      const peers = classifyPeers(torrent);
      const downloaded = torrent.downloaded || 0;
      const selections = Array.isArray(torrent._selections) ? torrent._selections.length : -1;

      if (firstByteAt === null && downloaded > 0) firstByteAt = t;
      if (tenMegAt === null && downloaded >= 10 * 1024 * 1024) tenMegAt = t;
      if (warmupBytes === null && t >= args.warmup) warmupBytes = downloaded;
      if (t >= args.warmup) samples.push(torrent.downloadSpeed || 0);
      peakInbound = Math.max(peakInbound, peers.inbound);
      peakPeers = Math.max(peakPeers, peers.total);

      if (args.csv) {
        console.log([
          t, downloaded, Math.round(torrent.downloadSpeed || 0),
          peers.total, peers.inbound, peers.seeds, peers.tcp, peers.utp, peers.webseed, peers.unchoked,
          selections, countCritical(torrent),
        ].join(','));
      }

      if (t >= total || torrent.done) {
        clearInterval(tick);
        resolve();
      }
    }, 1000);
  });

  // The headline number. Measured across the window only, from verified bytes
  // on disk — not from the EMA, and not including the warmup ramp.
  const measuredBytes = (torrent.downloaded || 0) - (warmupBytes || 0);
  const measuredSeconds = Math.max(1, t - args.warmup);
  const trueAverage = measuredBytes / measuredSeconds;
  const sorted = samples.slice().sort((a, b) => a - b);
  const peers = classifyPeers(torrent);

  console.error('');
  console.error('══ summary ═══════════════════════════════════════════');
  console.error('  profile              ' + args.profile + (preset ? ' · ' + args.torrent : ''));
  console.error('  TRUE AVERAGE         ' + fmtRate(trueAverage) + '   ← the metric');
  console.error('  bytes in window      ' + fmtBytes(measuredBytes) + ' over ' + measuredSeconds + 's');
  console.error('  p50 / p90 / peak     ' + fmtRate(percentile(sorted, 50)) + ' / ' + fmtRate(percentile(sorted, 90)) + ' / ' + fmtRate(sorted[sorted.length - 1] || 0));
  console.error('  time to first byte   ' + (firstByteAt === null ? 'never' : firstByteAt + 's'));
  console.error('  time to 10 MB        ' + (tenMegAt === null ? 'never' : tenMegAt + 's'));
  console.error('  peers now / peak     ' + peers.total + ' / ' + peakPeers + '  (' + peers.seeds + ' seeds, ' + peers.unchoked + ' unchoked)');
  console.error('  inbound now / peak   ' + peers.inbound + ' / ' + peakInbound + (peakInbound === 0 ? '   ← no inbound connectivity' : ''));
  console.error('  transport            TCP ' + peers.tcp + ' · uTP ' + peers.utp + ' · web ' + peers.webseed);
  console.error('  selections           ' + (Array.isArray(torrent._selections) ? torrent._selections.length : 'n/a'));
  console.error('  critical pieces      ' + countCritical(torrent));
  console.error('══════════════════════════════════════════════════════');

  // WebTorrent's destroy callback does not reliably fire while the DHT is
  // mid-lookup or trackers are mid-announce, and a benchmark that hangs after
  // printing its result is worse than useless in a loop. The summary is already
  // out; give teardown a bounded window and then leave.
  await Promise.race([
    new Promise((r) => client.destroy(r)),
    new Promise((r) => setTimeout(r, TEARDOWN_TIMEOUT_MS)),
  ]);
  if (nat) await nat.close().catch(() => {});
  if (!args.keep) fs.rmSync(scratch, { recursive: true, force: true });
  else console.error('# kept ' + scratch);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
