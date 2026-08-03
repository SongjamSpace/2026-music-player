#!/usr/bin/env node
'use strict';

/**
 * Where does traffic actually leave this machine, and out of which interfaces
 * *could* it leave?
 *
 * Exists because the answer is not guessable from configuration. A VPN installs
 * `0.0.0.0/1` and `128.0.0.0/1` routes that beat the default route without
 * replacing it, so the gateway still looks like the LAN router while every
 * packet goes out a tunnel — and a socket bound to the LAN address is refused
 * outright. This prints the ground truth in about a second.
 *
 *   node scripts/net-path-check.js
 *   node scripts/net-path-check.js --public-ip      # opt-in; contacts a third party
 *   node scripts/net-path-check.js --encryption 90  # 90s live swarm, encrypted fraction
 *
 * Reads only. Never changes routing, prefs or the library.
 */

const netPath = require('../main/net-path');

function parseArgs(argv) {
  const args = { publicIp: false, encryption: 0 };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--public-ip': args.publicIp = true; break;
      case '--encryption': args.encryption = Number(argv[++i]) || 60; break;
      case '--help':
      case '-h':
        console.error(`
net-path-check — which interface can reach the internet, and which one is used

  --public-ip        also ask an outside server for your address (off by default)
  --encryption <s>   join a live swarm for <s> seconds and report the encrypted fraction
`);
        process.exit(0);
        break;
      default:
        console.error('unknown flag: ' + argv[i]);
        process.exit(2);
    }
  }
  return args;
}

const pad = (s, n) => String(s).padEnd(n);

async function reportPath() {
  const egress = await netPath.detectEgress();
  console.log(
    'egress    ' +
      (egress
        ? egress.address + ' (' + egress.iface + (egress.tunnel ? ', tunnel' : ', physical') + ')'
        : 'unknown')
  );

  const pf = await netPath.preflight({ force: true });
  if (pf.unbound) {
    console.log(
      'unbound   ' + pad(pf.unbound.reachable ? 'REACHABLE' : 'BLOCKED', 10) +
        String(pf.unbound.ms).padStart(5) + 'ms'
    );
  }
  for (const name of Object.keys(pf.results)) {
    const r = pf.results[name];
    console.log(
      pad(name, 10) +
        pad(r.reachable ? 'REACHABLE' : 'BLOCKED', 10) +
        String(r.ms).padStart(5) + 'ms  ' +
        pad(r.code || '', 14) +
        (r.gateway ? 'gateway ' + r.gateway + (r.gatewayReachable ? ' reachable' : ' unreachable') : 'no gateway')
    );
  }

  const fp = await netPath.refreshFingerprint();
  console.log(
    'network   ' + (fp ? fp.gateway + ' / ' + fp.gatewayMac + ' on ' + fp.iface + '  id=' + fp.id : 'unidentified')
  );

  // The combination worth calling out: the interface is alive on the LAN but
  // has no route out, which is exactly what a not-yet-live split tunnel looks
  // like — and is indistinguishable from a dead NIC without the gateway probe.
  for (const name of Object.keys(pf.results)) {
    const r = pf.results[name];
    if (r.kind === 'physical' && !r.reachable && r.gatewayReachable) {
      console.log(
        '\nnote      ' + name + ' reaches its gateway but has no route to the internet (' +
          r.code + '). Something is routing past it — typically a VPN.'
      );
    }
  }
}

async function reportEncryption(seconds) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const WebTorrent = require('webtorrent');
  const { createTrackers } = require('../main/trackers');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-net-path-'));
  const trackers = createTrackers({ cacheDir: scratch, log: () => {} });
  await trackers.refresh();

  // secure:true is the whole point of this mode — the encrypted fraction cannot
  // be predicted from code, only measured against a real swarm.
  const client = new WebTorrent({ maxConns: 120, utp: true, secure: true });
  client.on('error', (err) => console.error('# client error: ' + err.message));

  const source =
    'https://archive.org/download/gd1977-05-08.shure57.stevenson.29303.flac16/' +
    'gd1977-05-08.shure57.stevenson.29303.flac16_archive.torrent';
  const torrent = client.add(source, { path: scratch, announce: trackers.list() });
  torrent.on('error', (err) => console.error('# torrent error: ' + err.message));
  torrent.on('warning', () => {});

  console.log('\nsampling encryption for ' + seconds + 's');
  console.log('t     tcp  encrypted  utp  web');
  await new Promise((resolve) => {
    let t = 0;
    const tick = setInterval(() => {
      t += 5;
      let tcp = 0, enc = 0, utp = 0, web = 0;
      for (const w of torrent.wires || []) {
        const type = w.type || '';
        if (type === 'tcpIncoming' || type === 'tcpOutgoing') {
          tcp++;
          if (w._encryptionMethod === 2) enc++;
        } else if (/^utp/.test(type)) utp++;
        else if (type === 'webSeed') web++;
      }
      console.log(
        pad(t + 's', 6) + pad(tcp, 5) + pad(enc, 11) + pad(utp, 5) + web
      );
      if (t >= seconds) {
        clearInterval(tick);
        resolve();
      }
    }, 5000);
  });

  await Promise.race([
    new Promise((r) => client.destroy(r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv);
  await reportPath();

  if (args.publicIp) {
    const r = await netPath.publicIp();
    console.log('public    ' + (r.error ? 'failed: ' + r.error : r.ip + ' via ' + r.via));
  }
  if (args.encryption) await reportEncryption(args.encryption);

  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
