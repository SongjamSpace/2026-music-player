#!/usr/bin/env node
'use strict';

/**
 * Packages the app into dist/<ProductName>-darwin-<arch>/<ProductName>.app.
 *
 * Nothing here is signed with a Developer ID — this is a personal build. It is
 * ad-hoc signed instead, which is what lets an arm64 Mac run it at all: Apple
 * silicon refuses to launch unsigned native code outright.
 */

const { packager } = require('@electron/packager');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

async function main() {
  const out = path.join(root, 'dist');
  fs.rmSync(out, { recursive: true, force: true });

  const paths = await packager({
    dir: root,
    out: out,
    overwrite: true,
    platform: 'darwin',
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    icon: path.join(root, 'build', 'icon.icns'),
    appBundleId: 'com.songjam.music-player-2026',
    appCategoryType: 'public.app-category.music',
    appVersion: pkg.version,
    // Signed separately below: packager's osxSign path wants a real identity in
    // the keychain and bails with "No identity found" for an ad-hoc build.
    osxSign: false,
    // Keep the bundle lean and stop dev tooling shipping inside it.
    prune: true,
    // Deliberately unpacked.
    //
    // Electron 28 cannot dynamic-import an ESM dependency from inside app.asar
    // (electron#38957, and #40211 for transitive resolution). main/nat.js does
    // exactly that for @silentbot1/nat-api, so with asar on, port mapping would
    // fail — silently, and only in the packaged build, since `npm start` is
    // unaffected. The alternative is enumerating that package's whole
    // transitive tree in asar.unpack, which breaks the moment it gains a dep.
    // For a personal ad-hoc build the size and cold-start cost of no archive is
    // not worth that failure mode. (Native .node files also can't load from
    // inside an archive, which unpacking handles for free.)
    asar: false,
    extendInfo: {
      // macOS 15+ prompts before allowing local network access, which UPnP's
      // SSDP multicast and NAT-PMP's unicast to the gateway both need. Without
      // this key the prompt gives the user no reason to say yes.
      NSLocalNetworkUsageDescription:
        'Finds your router so it can forward a port for peer-to-peer downloads. Without this, downloads are slower.',
    },
    ignore: [
      /^\/dist($|\/)/,
      /^\/scripts($|\/)/,
      /^\/build($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.claude($|\/)/,
      /^\/README\.md$/,
    ],
  });

  const app = paths[0];
  const bundle = fs.readdirSync(app).find((f) => f.endsWith('.app'));
  const full = path.join(app, bundle);

  // Ad-hoc signature over the whole bundle. Apple silicon refuses to launch
  // unsigned native code, and packager only leaves the linker's own signature
  // on the main binary — the helpers and frameworks need sealing too.
  console.log('Signing (ad-hoc)…');
  require('child_process').execSync(
    'codesign --force --deep --sign - ' + JSON.stringify(full),
    { stdio: 'inherit' }
  );
  require('child_process').execSync('codesign --verify --deep ' + JSON.stringify(full), {
    stdio: 'inherit',
  });
  const size = Number(
    require('child_process').execSync('du -sm ' + JSON.stringify(full)).toString().split('\t')[0]
  );
  console.log('\nBuilt: ' + full);
  console.log('Size:  ' + size + ' MB');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
