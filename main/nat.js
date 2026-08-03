/**
 * Router port mapping (UPnP-IGD / NAT-PMP).
 *
 * Without this the client is outbound-only: it can reach peers who are
 * themselves reachable, and is invisible to everyone who discovers it through
 * DHT, PEX or a tracker. On the small swarms a music library actually lives on,
 * that is routinely the difference between three peers and twenty — which makes
 * this the single biggest lever on real download speed.
 *
 * The dependency is ESM-only, so it is loaded through a dynamic import from
 * this CommonJS module. That works under `npm start`, but Electron 28 cannot
 * dynamic-import ESM from inside app.asar — see the asar note in
 * scripts/build-app.js.
 */

const os = require('os');
const dgram = require('dgram');

const CALL_TIMEOUT_MS = 6000;
const TTL_SECONDS = 1800;
const RETRY_DELAY_MS = 30000;

// Addresses that mean "the mapping cannot possibly help", so we report honestly
// instead of claiming success.
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** Point-to-point interfaces: a VPN or tunnel, not the LAN. */
const TUNNEL_IF = /^(utun|tun|tap|ppp|ipsec|wg)/i;

let NatAPI = null;
let client = null;
let ports = null;
let retryTimer = null;

function blankState() {
  return {
    attempted: false,
    mapped: false,
    method: null, // 'nat-pmp' | 'upnp'
    externalIp: null,
    mappedPorts: [],
    reachability: null, // 'ok' | 'vpn' | 'cgnat' | 'private-external' | null
    skipped: null, // 'tunnel' when the router was never asked, and why
    egress: null, // { address, iface, tunnel }
    defaultGateway: null,
    upnpDevice: null,
    hint: null,
    error: null,
    at: null,
  };
}

let state = blankState();

function log(...args) {
  console.log('[nat]', ...args);
}

/**
 * Routers that don't speak these protocols mostly just never answer, so every
 * call needs its own deadline or startup hangs on a silent gateway.
 */
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timed out after ' + CALL_TIMEOUT_MS + 'ms')), CALL_TIMEOUT_MS)
    ),
  ]);
}

async function loadNatAPI() {
  if (!NatAPI) {
    const mod = await import('@silentbot1/nat-api');
    NatAPI = mod.default || mod;
  }
  return NatAPI;
}

/**
 * Try one protocol in isolation.
 *
 * nat-api's own `map()` tries NAT-PMP then UPnP and reports only a boolean, so
 * asking each separately is the only way to tell the user *how* they got
 * mapped — which matters, because "UPnP worked" and "NAT-PMP worked" point at
 * different things to check when it later stops working.
 */
async function attempt(Ctor, method, { torrentPort, dhtPort }) {
  const instance = new Ctor({
    enablePMP: method === 'nat-pmp',
    enableUPNP: method === 'upnp',
    ttl: TTL_SECONDS,
    autoUpdate: true,
    upnpPermanentFallback: true,
    description: '2026 Music Player',
  });

  try {
    // protocol: null maps BOTH TCP and UDP on this port. Required, not
    // belt-and-braces: webtorrent runs uTP over UDP on the same numeric port
    // its TCP listener uses, so a TCP-only mapping leaves half the peers out.
    const okTorrent = await withTimeout(
      instance.map({ publicPort: torrentPort, privatePort: torrentPort, protocol: null }),
      method + ' torrent port'
    );
    if (!okTorrent) throw new Error('gateway declined the torrent port mapping');

    const okDht = await withTimeout(
      instance.map({ publicPort: dhtPort, privatePort: dhtPort, protocol: 'UDP' }),
      method + ' dht port'
    );
    // A working torrent port is the win; DHT is a bonus and not worth failing over.
    if (!okDht) log('DHT port ' + dhtPort + ' was not mapped (torrent port succeeded)');

    return { instance, mappedPorts: okDht ? [torrentPort, dhtPort] : [torrentPort] };
  } catch (err) {
    // Bounded, because this is the failure path: whatever made map() hang can
    // just as easily make destroy() hang, and that would wedge startup.
    try {
      await withTimeout(Promise.resolve(instance.destroy()), method + ' cleanup');
    } catch (_) {
      /* leaked sockets on an already-failing path; the process outlives them */
    }
    throw err;
  }
}

/**
 * Work out *why* mapping failed, in terms the user can act on.
 *
 * SSDP returns whichever device answers first, and plenty of networks have a
 * second router, mesh node or NAS advertising an InternetGatewayDevice it can't
 * actually honour. When that responder isn't the real default gateway, "UPnP
 * failed" is misleading — the router that matters was never asked.
 */
async function diagnose() {
  try {
    const { gateway4sync } = await import('default-gateway');
    state.defaultGateway = gateway4sync().gateway;
  } catch (_) {
    state.defaultGateway = null;
  }

  try {
    const { default: NatUPNP } = await import('@silentbot1/nat-api/lib/upnp/index.js');
    const upnp = new NatUPNP({ permanentFallback: true });
    const found = await withTimeout(upnp.findGateway(), 'findGateway');
    state.upnpDevice = new URL(found.gateway.url).hostname;
    if (upnp.destroy) upnp.destroy();
  } catch (_) {
    state.upnpDevice = null;
  }

  state.egress = await detectEgress();
  if (state.egress && state.egress.tunnel) {
    // Worth leading with even though mapping failed: fixing the router would
    // not have helped anyway while a VPN is carrying the traffic.
    state.reachability = 'vpn';
    state.hint =
      'Traffic leaves through a VPN (' + state.egress.iface + '), so a router port forward would ' +
      'not apply regardless. Whether peers can still reach you depends on your VPN — the ' +
      'Connection panel under an album shows the live inbound count.';
    return;
  }

  if (!state.upnpDevice && !state.defaultGateway) {
    state.hint = 'No router found on the network.';
  } else if (!state.upnpDevice) {
    state.hint =
      'Your router at ' + state.defaultGateway + ' is not advertising UPnP. ' +
      'Enable UPnP in its settings, or forward the listen port to this Mac manually.';
  } else if (state.defaultGateway && state.upnpDevice !== state.defaultGateway) {
    // The exact shape of a double-NAT or a mesh node in AP mode.
    state.hint =
      'The only device offering UPnP is ' + state.upnpDevice + ', but your gateway is ' +
      state.defaultGateway + '. Enable UPnP on ' + state.defaultGateway +
      ', or forward the listen port there manually.';
  } else {
    state.hint =
      'Your router refused the port mapping. Enable UPnP or NAT-PMP in its settings, ' +
      'or forward the listen port to this Mac manually. On macOS 15+, also check ' +
      'System Settings → Privacy & Security → Local Network.';
  }
}

/**
 * Which local address the kernel would use to reach the public internet.
 *
 * `connect()` on a UDP socket sends nothing — it just performs the routing
 * lookup and binds a source address — so this is a purely local question with
 * no packets, no third-party IP-echo service, and no privacy cost.
 *
 * It exists because a router port mapping is only worth anything if traffic
 * actually leaves through that router. VPN clients typically install
 * `0.0.0.0/1` and `128.0.0.0/1` routes, which beat the default route without
 * replacing it — so the gateway still looks like the LAN router while every
 * packet goes out a tunnel.
 */
function detectEgress() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket('udp4');
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (_) {
        /* never opened */
      }
      resolve(value);
    };
    socket.once('error', () => finish(null));
    try {
      socket.connect(53, '1.1.1.1', () => {
        let address = null;
        try {
          address = socket.address().address;
        } catch (_) {
          /* unbound */
        }
        if (!address) return finish(null);
        let iface = null;
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
          if ((addrs || []).some((a) => a.address === address)) {
            iface = name;
            break;
          }
        }
        finish({ address, iface, tunnel: !!iface && TUNNEL_IF.test(iface) });
      });
    } catch (_) {
      finish(null);
    }
  });
}

/**
 * A VPN outranks everything else: if packets don't traverse the router, what
 * the router's WAN address happens to be is beside the point.
 */
function classifyReachability(externalIp, egress) {
  if (egress && egress.tunnel) return 'vpn';
  if (!externalIp) return null;
  if (CGNAT.test(externalIp)) return 'cgnat';
  if (PRIVATE.test(externalIp)) return 'private-external';
  return 'ok';
}

/**
 * Map the listen ports. Never throws — a failure here must not stop the app
 * from starting, it just means slower downloads.
 */
async function open(nextPorts) {
  ports = nextPorts;
  clearTimeout(retryTimer);
  retryTimer = null;

  const { torrentPort, dhtPort } = ports;
  state = Object.assign(blankState(), { attempted: true, at: Date.now() });

  // If traffic egresses a tunnel, the LAN router is not in the path and mapping
  // a port on it cannot possibly help. Asking anyway costs seconds of SSDP
  // timeouts at startup and, worse, produces a "mapped" claim that is false in
  // the only sense the user cares about. The provider's forwarded port is what
  // matters here, and inbound peers are the evidence for it.
  state.egress = await detectEgress();
  if (state.egress && state.egress.tunnel) {
    state.skipped = 'tunnel';
    state.reachability = 'vpn';
    state.hint =
      'Traffic leaves through ' + state.egress.iface + ', so the router is not in the path. ' +
      'Incoming connections depend on your VPN forwarding a port to you.';
    log('skipping router mapping — egress is ' + state.egress.iface + ' (tunnel)');
    return status();
  }

  let Ctor;
  try {
    Ctor = await loadNatAPI();
  } catch (err) {
    state.error = 'could not load nat-api: ' + err.message;
    log(state.error);
    return status();
  }

  const errors = [];
  for (const method of ['nat-pmp', 'upnp']) {
    try {
      const result = await attempt(Ctor, method, { torrentPort, dhtPort });
      client = result.instance;
      state.mapped = true;
      state.method = method;
      state.mappedPorts = result.mappedPorts;
      log('mapped ports ' + result.mappedPorts.join(', ') + ' via ' + method);
      break;
    } catch (err) {
      errors.push(method + ': ' + err.message);
    }
  }

  if (!state.mapped) {
    state.error = errors.join(' · ');
    await diagnose();
    log('no port mapping — ' + state.error);
    log(state.hint);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      log('retrying port mapping');
      open(ports);
    }, RETRY_DELAY_MS);
    return status();
  }

  try {
    state.externalIp = (await withTimeout(client.externalIp(), 'externalIp')) || null;
  } catch (_) {
    state.externalIp = null;
  }

  state.egress = await detectEgress();
  state.reachability = classifyReachability(state.externalIp, state.egress);

  if (state.reachability === 'vpn') {
    // Deliberately does not claim peers can't reach you. Some providers do
    // forward, and some NATs are permissive enough that connections arrive
    // anyway — we have observed inbound peers in exactly this configuration.
    // The live inbound count is the evidence; this is only the mechanism.
    state.hint =
      'Traffic leaves through a VPN (' + state.egress.iface + '), so the router\'s port forward ' +
      'does not apply. Whether peers can still reach you depends on your VPN — the Connection ' +
      'panel under an album shows the live inbound count.';
  } else if (state.reachability === 'cgnat') {
    state.hint =
      'Your ISP gave the router a shared address (' + state.externalIp + '), so there is no public ' +
      'address to forward to. Only your ISP can change this.';
  } else if (state.reachability === 'private-external') {
    state.hint =
      'The router was given a private address (' + state.externalIp + '), which means a second ' +
      'router sits in front of it. Forward the port on that one too.';
  }
  if (state.hint) log(state.hint);

  return status();
}

/** Release the mappings. Safe to call when nothing was ever mapped. */
async function close() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const instance = client;
  client = null;
  state.mapped = false;
  state.mappedPorts = [];
  if (!instance) return;
  try {
    // destroy() unmaps everything this instance opened.
    await withTimeout(instance.destroy(), 'destroy');
    log('released port mappings');
  } catch (err) {
    // The TTL expires them anyway; a wedged router must not block quit.
    log('could not cleanly release mappings: ' + err.message);
  }
}

async function retry() {
  await close();
  if (!ports) return status();
  return open(ports);
}

function status() {
  return Object.assign({}, state, { mappedPorts: state.mappedPorts.slice() });
}

// detectEgress is exported for main/net-path.js, which builds on it. It lives
// here because nat.js needs it first, to decide whether a port mapping is even
// in the traffic path.
module.exports = { open, close, retry, status, detectEgress };
