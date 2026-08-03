/**
 * Which way traffic actually leaves this machine.
 *
 * Sibling to main/nat.js: that module is about the router, this one is about
 * which interface the kernel picks before the router is even involved. They
 * answer different halves of "can peers reach me".
 *
 * The app deliberately offers no interface selector, and this module exists
 * partly to make that honest. Node exposes only `localAddress` — a source-IP
 * bind — and not `IP_BOUND_IF`, which is the call that actually scopes a route
 * lookup to an interface. Source binding does not change route selection: with
 * a VPN's `0/1` and `128.0/1` routes in place, a socket bound to the LAN
 * address still tries to egress the tunnel and the kernel refuses it outright.
 * So the app reads routing state and never writes it, and anything resembling a
 * switch would be a lie.
 *
 * That refusal is fast and specific, which is what makes this useful: binding
 * to an interface with no route out fails `EHOSTUNREACH` in about a
 * millisecond, locally, before a packet is sent. A full sweep of every
 * interface costs a few hundred milliseconds.
 *
 * Uses only Node builtins on purpose. nat.js needs a dynamic ESM import and
 * therefore carries the Electron-28-can't-import-from-asar caveat; this module
 * runs on the Settings path where that failure would be invisible, so it stays
 * out of that trap entirely.
 */

const os = require('os');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { detectEgress } = require('./nat');

// Two targets so one filtered anycast host can't be mistaken for a dead
// interface. Both are IP literals: a resolver bound to the tunnel would
// otherwise turn every probe into a false negative before it started.
const PROBE_TARGETS = [
  { host: '1.1.1.1', port: 443 },
  { host: '9.9.9.9', port: 443 },
];
const PROBE_TIMEOUT_MS = 2500;
const GATEWAY_TIMEOUT_MS = 800;
const SUBPROCESS_TIMEOUT_MS = 2000;

// The Settings dialog polls every 2s; probing at that rate would be silly.
const PREFLIGHT_MIN_INTERVAL_MS = 15000;

const PUBLIC_IP_TIMEOUT_MS = 6000;

const TUNNEL_IF = /^(utun|tun|tap|ppp|ipsec|wg)/i;
const VIRTUAL_IF = /^(bridge|vmnet|vnic|awdl|llw|ap\d|anpi)/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

let expected = null; // 'auto' | 'direct' | 'vpn' | 'vpn-preferred'
let home = null; // stored fingerprint
let cachedPreflight = null;
let inFlight = null;
let cachedFingerprint = null;
let cachedEgress = null;
let lastPublicIp = null;

function log(...args) {
  console.log('[net-path]', ...args);
}

// -- interfaces --------------------------------------------------------------

function classify(name) {
  if (TUNNEL_IF.test(name)) return 'tunnel';
  if (VIRTUAL_IF.test(name)) return 'virtual';
  return 'physical';
}

/**
 * Routable IPv4 addresses, one per interface.
 *
 * The link-local filter is load-bearing beyond tidiness: macOS keeps several
 * system `utun` interfaces up at all times for Handoff and friends, and they
 * carry no routable IPv4. Dropping them is what leaves `tunnel` meaning "a VPN
 * is actually up", which the expectation logic depends on.
 */
function candidates() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      out.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        cidr: addr.cidr || null,
        mac: addr.mac || null,
        kind: classify(name),
      });
    }
  }
  return out;
}

// -- reachability ------------------------------------------------------------

/**
 * Map a connect outcome onto a verdict.
 *
 * ECONNREFUSED counts as *reachable* — something answered, so the path is live
 * and only the port is shut. Treating it as failure is how a probe ends up
 * declaring a working interface dead.
 */
function verdictFor(err) {
  if (!err) return { reachable: true, verdict: 'ok' };
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ECONNRESET':
      return { reachable: true, verdict: 'blocked' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { reachable: false, verdict: 'no-route' };
    case 'EADDRNOTAVAIL':
    case 'EINVAL':
      return { reachable: false, verdict: 'bad-address' };
    case 'ETIMEDOUT':
      return { reachable: false, verdict: 'timeout' };
    default:
      return { reachable: false, verdict: 'error' };
  }
}

function connectOnce({ host, port, localAddress, timeout }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy(); // never end(): a half-open peer would keep us waiting
      const v = verdictFor(err);
      resolve({
        ...v,
        ms: Date.now() - startedAt,
        code: err ? err.code || err.message : null,
        target: host + ':' + port,
      });
    };
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', finish);
    socket.once('connect', () => finish(null));
    try {
      socket.connect(localAddress ? { host, port, localAddress } : { host, port });
    } catch (err) {
      finish(err);
    }
  });
}

/** Can a socket bound to this address reach the internet? */
async function probeInterface(localAddress, opts = {}) {
  const timeout = opts.timeout || PROBE_TIMEOUT_MS;
  const results = await Promise.all(
    PROBE_TARGETS.map((t) => connectOnce({ ...t, localAddress, timeout }))
  );
  const win = results.find((r) => r.reachable);
  const best = win || results[0];
  return {
    reachable: !!win,
    verdict: best.verdict,
    ms: best.ms,
    code: best.code,
    detail: win
      ? win.target + ' in ' + win.ms + ' ms'
      : results.map((r) => r.target + ' ' + (r.code || r.verdict)).join(', '),
  };
}

function routeGateway(iface) {
  return new Promise((resolve) => {
    execFile(
      '/sbin/route',
      ['-n', 'get', '-ifscope', iface, 'default'],
      { timeout: SUBPROCESS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /gateway:\s*(\S+)/.exec(stdout || '');
        resolve(m && IPV4.test(m[1]) ? m[1] : null);
      }
    );
  });
}

/**
 * Separates "the cable is unplugged" from "the cable is fine, the routes send
 * everything somewhere else" — which is precisely the not-yet-live split tunnel
 * case, and not something the internet probe alone can tell you.
 */
async function probeGateway(iface, localAddress) {
  const gateway = await routeGateway(iface);
  if (!gateway) return { gateway: null, reachable: false };
  const r = await connectOnce({
    host: gateway,
    port: 80,
    localAddress,
    timeout: GATEWAY_TIMEOUT_MS,
  });
  return { gateway, reachable: r.reachable };
}

/**
 * Probe every interface, plus the unbound default route for comparison.
 *
 * Rate-limited and shared rather than run on demand: the Settings poll asks for
 * status twice a second, and the only two things that should trigger real
 * probes are opening the dialog and pressing Test.
 */
function preflight({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (!force && cachedPreflight && Date.now() - cachedPreflight.at < PREFLIGHT_MIN_INTERVAL_MS) {
    return Promise.resolve({ ...cachedPreflight, stale: true });
  }

  const previous = cachedPreflight;
  inFlight = (async () => {
    // Owned here rather than read off nat.status(): nat only detects egress as
    // a side effect of attempting a port mapping, and it skips that entirely
    // when the listen port falls back to ephemeral. The traffic path must still
    // be reportable then — that is precisely a moment the user wants to look.
    cachedEgress = await detectEgress();
    const list = candidates();
    const [unbound, ...perInterface] = await Promise.all([
      probeInterface(undefined),
      ...list.map(async (c) => {
        const [internet, gateway] = await Promise.all([
          probeInterface(c.address),
          probeGateway(c.name, c.address),
        ]);
        return { ...c, ...internet, gateway: gateway.gateway, gatewayReachable: gateway.reachable };
      }),
    ]);

    const results = {};
    for (const r of perInterface) {
      results[r.name] = r;
      log(
        r.name + ' ' + r.address + ' → ' + r.verdict +
        ' (' + (r.code || 'ok') + ', ' + r.ms + 'ms)' +
        (r.gateway ? ', gateway ' + r.gateway + (r.gatewayReachable ? ' reachable' : ' unreachable') : '')
      );
      // Worth shouting about unprompted: a physical interface losing its route
      // is the exact moment a split tunnel stops working.
      const before = previous && previous.results[r.name];
      if (before && before.reachable && !r.reachable && r.kind === 'physical') {
        console.warn('[net-path] ' + r.name + ' lost its route to the internet (' + r.code + ')');
      }
    }

    cachedPreflight = { at: Date.now(), stale: false, unbound, results };
    return cachedPreflight;
  })()
    .catch((err) => {
      log('preflight failed:', err.message);
      cachedPreflight = { at: Date.now(), stale: false, unbound: null, results: {}, error: err.message };
      return cachedPreflight;
    })
    .then((r) => {
      inFlight = null;
      return r;
    });

  return inFlight;
}

// -- network identity --------------------------------------------------------

function arpMac(gateway) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/arp', ['-n', gateway], { timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(null);
      const m = / at ([0-9a-fA-F:]+) on /.exec(stdout || '');
      if (!m || /incomplete/i.test(m[1])) return resolve(null);
      // macOS prints unpadded octets ("0:e0:4c:68:1:44"). Without normalising,
      // the same router fingerprints two different ways depending on which tool
      // produced the string.
      const mac = m[1]
        .split(':')
        .map((o) => o.toLowerCase().padStart(2, '0'))
        .join(':');
      resolve(mac);
    });
  });
}

/**
 * Identify the network we're attached to, for the "is this home?" check.
 *
 * Always fingerprints a *physical* interface's gateway, even when traffic is
 * currently egressing a tunnel — otherwise this would fingerprint the VPN's own
 * gateway, which is identical on every network you ever connect from.
 *
 * Returns null rather than a partial fingerprint when the MAC is unavailable. A
 * fingerprint of gateway-IP-and-subnet alone would match any router on
 * 192.168.x.1, which is most of them.
 */
async function fingerprint() {
  const physical = candidates().filter((c) => c.kind === 'physical');
  for (const c of physical) {
    const gateway = await routeGateway(c.name);
    if (!gateway) continue;
    const gatewayMac = await arpMac(gateway);
    if (!gatewayMac) continue;
    const material = [c.kind, c.cidr || c.address, gateway, gatewayMac].join('|');
    return {
      iface: c.name,
      kind: c.kind,
      cidr: c.cidr || null,
      gateway,
      gatewayMac,
      id: crypto.createHash('sha256').update(material).digest('hex').slice(0, 16),
    };
  }
  return null;
}

async function refreshFingerprint() {
  cachedFingerprint = await fingerprint();
  return cachedFingerprint;
}

// -- public IP ---------------------------------------------------------------

function httpsText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: PUBLIC_IP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
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

/**
 * The only thing in this module that talks to anyone else, so it is strictly
 * user-initiated — never on launch, never on a timer.
 *
 * Cloudflare's trace endpoint is addressed by IP literal, so the lookup isn't
 * handed to a DNS resolver on the way out, and it's an operator already used as
 * a probe target — one fewer party than introducing a new one.
 */
async function publicIp() {
  try {
    const body = await httpsText('https://1.1.1.1/cdn-cgi/trace');
    const m = /^ip=(.+)$/m.exec(body);
    if (m) {
      lastPublicIp = { ip: m[1].trim(), at: Date.now(), via: '1.1.1.1' };
      return lastPublicIp;
    }
    throw new Error('unexpected response');
  } catch (first) {
    try {
      const body = await httpsText('https://api.ipify.org');
      lastPublicIp = { ip: body.trim(), at: Date.now(), via: 'api.ipify.org' };
      return lastPublicIp;
    } catch (second) {
      lastPublicIp = { error: first.message + ' / ' + second.message, at: Date.now() };
      return lastPublicIp;
    }
  }
}

function clearPublicIp() {
  lastPublicIp = null;
}

// -- status ------------------------------------------------------------------

function setExpected(value) {
  expected = value || null;
}

function setHome(fp) {
  home = fp || null;
}

/**
 * Cheap and synchronous — safe to call from the 2s diagnostics poll. Everything
 * expensive (probes, subprocesses, network) is served from cache here and
 * refreshed only on explicit triggers.
 */
function status() {
  const list = candidates();
  const current = cachedFingerprint;
  return {
    expected,
    egress: cachedEgress,
    candidates: list,
    tunnelAvailable: list.some((c) => c.kind === 'tunnel'),
    physicalAvailable: list.some((c) => c.kind === 'physical'),
    preflight: cachedPreflight,
    home,
    network: current,
    homeMatch: home && current ? home.id === current.id : null,
    publicIp: lastPublicIp,
  };
}

module.exports = {
  detectEgress,
  candidates,
  probeInterface,
  probeGateway,
  preflight,
  fingerprint,
  refreshFingerprint,
  publicIp,
  clearPublicIp,
  setExpected,
  setHome,
  status,
};
