const fs = require('fs');
const path = require('path');
const https = require('https');

// A magnet carries only whatever `tr=` params whoever generated it happened to
// include, and plenty carry none at all. Without a default announce list the
// only peer discovery left is DHT, which on a small album swarm frequently
// means finding nobody. These get merged into every magnet add — webtorrent
// concatenates `opts.announce` onto the magnet's own list and dedupes, so this
// never clobbers trackers the magnet already names.

const LIST_URL = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

// Announcing to an unbounded list costs a UDP round trip and a timer per
// tracker per torrent, for rapidly diminishing returns past the first handful.
const MAX_TRACKERS = 40;

/**
 * Hardcoded fallback. Used on first run, when the network is down, and as the
 * union partner for the fetched list. Deliberately all UDP/HTTPS:
 *
 * `ws://` trackers are excluded on purpose. They only return WebRTC peers, and
 * this is a Node client with no `wrtc` — it would announce, get peers it cannot
 * dial, and emit warnings for the trouble.
 */
/*
 * Ordered best-measured-first. Entries removed after being timed on this
 * network, because each dead one costs a 15 s announce timeout and the whole
 * list is tried on every add:
 *   tracker.opentrackr.org, exodus.desync.com, bt1/bt2.archive.org  — UDP timeout
 *   tracker.tamersunion.org, tracker.gbitt.info, tracker.tiny-vps.com,
 *   tracker.moeking.me                                             — DNS ENOTFOUND
 *   tracker.openbittorrent.com                                     — HTTP 403
 * The live refresh normally supersedes this list, so it matters most on first
 * run and offline — which is exactly when a stack of timeouts hurts.
 */
const DEFAULT_TRACKERS = [
  // Confirmed working, in measured order of usefulness.
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.publictracker.xyz:6969/announce',
  // Unverified here but widely alive; harmless behind the ones above.
  'udp://explodie.org:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://bt.ktrackers.com:6666/announce',
  'udp://isk.richardsw.club:6969/announce',
];

const SUPPORTED_SCHEME = /^(udp|https?):\/\/.+/i;

function sanitise(lines) {
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const url = String(raw || '').trim();
    if (!url || !SUPPORTED_SCHEME.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Plain https GET with a timeout and bounded redirect following. */
function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchText(new URL(headers.location, url).href, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {string|null} opts.cacheDir  Where to persist the fetched list. Null disables caching.
 * @param {function=} opts.log
 */
function createTrackers({ cacheDir, log = () => {} } = {}) {
  const cacheFile = cacheDir ? path.join(cacheDir, 'trackers.txt') : null;
  let list = DEFAULT_TRACKERS.slice(0, MAX_TRACKERS);
  let source = 'builtin';
  let updatedAt = null;
  let refreshing = null;

  function adopt(fetched, why) {
    // Fetched entries first: trackerslist ranks by measured uptime, so its order
    // is meaningful. The builtin list backfills anything the cap leaves room for.
    list = sanitise(fetched.concat(DEFAULT_TRACKERS)).slice(0, MAX_TRACKERS);
    source = why;
  }

  function loadCache() {
    if (!cacheFile) return false;
    try {
      const stat = fs.statSync(cacheFile);
      adopt(fs.readFileSync(cacheFile, 'utf8').split('\n'), 'cache');
      updatedAt = stat.mtimeMs;
      return true;
    } catch (_) {
      return false;
    }
  }

  loadCache();

  /**
   * Refresh from the network at most once a day. Never throws and never blocks
   * startup — on any failure the cached (or builtin) list stays in place.
   *
   * Torrents already running are not retrofitted: webtorrent 1.x has no
   * `torrent.addTracker`. A fresh list applies to subsequent adds and to the
   * next launch, which is soon enough for a list that changes on the order of
   * weeks.
   */
  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    if (!force && updatedAt && Date.now() - updatedAt < REFRESH_INTERVAL_MS) {
      return Promise.resolve(list.slice());
    }
    refreshing = fetchText(LIST_URL)
      .then((body) => {
        const fetched = sanitise(body.split('\n'));
        if (!fetched.length) throw new Error('list was empty');
        adopt(fetched, 'remote');
        updatedAt = Date.now();
        if (cacheFile) {
          try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, list.join('\n'));
          } catch (err) {
            log('[trackers] could not cache list: ' + err.message);
          }
        }
        log('[trackers] refreshed: ' + list.length + ' trackers');
      })
      .catch((err) => {
        log('[trackers] refresh failed (' + err.message + '), using ' + source + ' list');
      })
      .then(() => {
        refreshing = null;
        return list.slice();
      });
    return refreshing;
  }

  return {
    list: () => list.slice(),
    refresh,
    status: () => ({ count: list.length, source, updatedAt }),
  };
}

module.exports = { createTrackers, DEFAULT_TRACKERS, MAX_TRACKERS };
