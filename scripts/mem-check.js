#!/usr/bin/env node
'use strict';

/**
 * Measures the running app's real memory cost.
 *
 * `ps -o rss` is actively misleading here and was the reason this problem looked
 * small for so long: on macOS a process whose pages have been compressed or
 * swapped reports a small RSS while its actual footprint is many times larger.
 * The measured case was a main process reporting ~160 MB RSS against a 1.93 GB
 * physical footprint with 1.8 GB swapped out — and it is the swapping, not the
 * allocation, that produces the beachball.
 *
 * So: `top`'s MEM column and `vmmap`'s "Physical footprint", never RSS.
 *
 *   node scripts/mem-check.js
 *   node scripts/mem-check.js --json
 *   node scripts/mem-check.js --watch 5      # sample every 5s until Ctrl-C
 *   node scripts/mem-check.js --vmmap        # add swap/dirty detail for main
 *   node scripts/mem-check.js --cpu 60       # average CPU over 60s (see cpuSeconds)
 */

const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Two ways this app runs, and the measurement has to work for both:
 *   packaged  /Applications/2026 Music Player.app/Contents/MacOS/2026 Music Player
 *   from source  <repo>/node_modules/electron/dist/Electron.app/…/Electron .
 *
 * The dev run is the one you get from `npm start`, and it does not carry the
 * product name anywhere in argv — it is identified by the repo path instead.
 */
const PACKAGED_MATCH = '2026 Music Player';
const REPO_ROOT = path.resolve(__dirname, '..');

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // `top` on a pid that exited mid-sample exits non-zero with usable stdout.
    return (err && err.stdout) || '';
  }
}

/** Parse a macOS memory size like "1933M", "1.9G", "624K" into bytes. */
function parseSize(text) {
  const m = /^([\d.]+)\s*([KMGT]?)/.exec(String(text).trim());
  if (!m) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]] || 1;
  return Number(m[1]) * mult;
}

function mb(bytes) {
  return (bytes / 1024 ** 2).toFixed(0);
}

/**
 * Classify an Electron process from its argv.
 *
 * The main (browser) process is the one with no `--type=`, and it is the one
 * that matters: it owns the torrent client, the piece caches and every wire.
 */
function roleOf(args) {
  // Crashpad carries no --type=, so it would otherwise read as a second main
  // process and quietly inflate the totals.
  if (/crashpad_handler|ptype=crashpad/.test(args)) return 'crashpad';
  const m = /--type=([a-z-]+)/.exec(args);
  if (!m) return 'main';
  if (m[1] === 'renderer') return 'renderer';
  if (m[1] === 'gpu-process') return 'gpu';
  const sub = /--utility-sub-type=([^\s]+)/.exec(args);
  if (sub) return 'utility:' + sub[1].split('.')[0];
  return m[1];
}

function processes() {
  const out = sh('ps', ['-Ao', 'pid=,args=']);
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[2];
    // Never count the tooling that merely mentions the name — this script, an
    // editor with the file open, a grep.
    if (args.indexOf('mem-check') !== -1) continue;
    if (!/\.app\/Contents\//.test(args)) continue;

    const packaged = args.indexOf(PACKAGED_MATCH) !== -1;
    // A dev run is Electron's own binary plus this repo somewhere in argv (the
    // app path for the browser process, --user-data-dir or the preload for the
    // children).
    const dev = /node_modules\/electron\/dist\//.test(args) && args.indexOf(REPO_ROOT) !== -1;
    if (!packaged && !dev) continue;

    found.push({ pid: Number(m[1]), role: roleOf(args), dev: dev && !packaged });
  }
  return found;
}

/**
 * Cumulative CPU seconds per pid, from `ps -o time`.
 *
 * This is the honest way to compare CPU between builds. `top`'s instantaneous
 * percentage is extremely spiky for a torrent client — consecutive samples of the
 * same process a second apart measured 52% and 1.5%, because the work arrives in
 * bursts of piece verification and wire encryption. Any single sample can be made
 * to say whatever you want. CPU-seconds accumulated over a fixed wall-clock
 * window cannot.
 *
 * Used by --cpu, which is what to quote when claiming a CPU improvement.
 */
function cpuSeconds(pid) {
  const out = sh('ps', ['-o', 'time=', '-p', String(pid)]).trim();
  const parts = out.split(':').map(Number);
  if (!parts.length || parts.some(isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * `top -l 2` because the first sample's CPU is a since-launch average, not now.
 *
 * The `cpu` in the result is therefore one instantaneous sample, and for this app
 * it is spiky enough to be misleading on its own — see cpuSeconds() and --cpu.
 */
function sample(procs) {
  if (!procs.length) return [];
  const args = ['-l', '2', '-stats', 'pid,mem,cpu'];
  procs.forEach((p) => args.push('-pid', String(p.pid)));
  const out = sh('top', args);
  // Keep only the final sample block.
  const blocks = out.split(/^Processes:/m);
  const last = blocks[blocks.length - 1] || out;
  const byPid = new Map();
  for (const line of last.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (m) byPid.set(Number(m[1]), { footprint: parseSize(m[2]), cpu: Number(m[3]) });
  }
  return procs.map((p) => Object.assign({}, p, byPid.get(p.pid) || { footprint: 0, cpu: 0 }));
}

/** Swap and dirty detail, which is what distinguishes "big" from "thrashing". */
function vmmapDetail(pid) {
  const out = sh('vmmap', ['-summary', String(pid)]);
  const foot = /Physical footprint:\s+(\S+)/.exec(out);
  const peak = /Physical footprint \(peak\):\s+(\S+)/.exec(out);
  const writable = /Writable regions:.*written=(\S+?)\(.*swapped_out=(\S+?)\(/.exec(out);
  return {
    footprint: foot ? parseSize(foot[1]) : 0,
    peak: peak ? parseSize(peak[1]) : 0,
    written: writable ? parseSize(writable[1]) : 0,
    swappedOut: writable ? parseSize(writable[2]) : 0,
  };
}

function report(asJson, withVmmap) {
  const procs = processes();
  if (!procs.length) {
    if (asJson) console.log(JSON.stringify({ running: false }));
    else console.log('\n  app is not running\n');
    return false;
  }

  const rows = sample(procs).sort((a, b) => b.footprint - a.footprint);
  const total = rows.reduce((n, r) => n + r.footprint, 0);
  const main = rows.find((r) => r.role === 'main');
  const detail = withVmmap && main ? vmmapDetail(main.pid) : null;

  if (asJson) {
    console.log(JSON.stringify({ running: true, rows: rows, totalBytes: total, main: detail }, null, 2));
    return true;
  }

  console.log('');
  console.log('  ' + 'pid'.padStart(7) + 'footprint'.padStart(12) + 'cpu%'.padStart(8) + '  role');
  for (const r of rows) {
    console.log(
      '  ' +
        String(r.pid).padStart(7) +
        (mb(r.footprint) + ' MB').padStart(12) +
        r.cpu.toFixed(1).padStart(8) +
        '  ' +
        r.role
    );
  }
  console.log('  ' + ''.padStart(7) + (mb(total) + ' MB').padStart(12) + '        ' + '  TOTAL');
  if (detail) {
    console.log('');
    console.log('  main process detail (vmmap):');
    console.log('    physical footprint  ' + mb(detail.footprint) + ' MB (peak ' + mb(detail.peak) + ' MB)');
    console.log('    writable written    ' + mb(detail.written) + ' MB');
    console.log('    swapped out         ' + mb(detail.swappedOut) + ' MB');
    if (detail.swappedOut > 512 * 1024 ** 2) {
      console.log('    ^ this is the beachball: pages are being compressed/swapped, not merely allocated');
    }
  }
  console.log('');
  return true;
}

/**
 * Average CPU over a real window, printed as a percentage of one core.
 *
 * Blocking is fine here: this is a measurement tool and the wait is the point.
 */
function reportCpu(seconds) {
  const procs = processes();
  if (!procs.length) {
    console.log('\n  app is not running\n');
    return false;
  }
  const before = new Map(procs.map((p) => [p.pid, cpuSeconds(p.pid)]));
  const startedAt = Date.now();
  console.log('\n  sampling CPU for ' + seconds + 's…');
  // Deliberately synchronous — see above.
  execFileSync('/bin/sleep', [String(seconds)]);
  const elapsed = (Date.now() - startedAt) / 1000;

  console.log('');
  console.log('  ' + 'pid'.padStart(7) + 'cpu-avg'.padStart(10) + '  role');
  let total = 0;
  for (const p of procs) {
    const a = before.get(p.pid);
    const b = cpuSeconds(p.pid);
    if (a == null || b == null) continue;
    const pct = ((b - a) / elapsed) * 100;
    total += pct;
    console.log('  ' + String(p.pid).padStart(7) + (pct.toFixed(1) + '%').padStart(10) + '  ' + p.role);
  }
  console.log('  ' + ''.padStart(7) + (total.toFixed(1) + '%').padStart(10) + '  TOTAL (of one core)');
  console.log('');
  return true;
}

function main() {
  const asJson = process.argv.includes('--json');
  const withVmmap = process.argv.includes('--vmmap');
  const cpuIndex = process.argv.indexOf('--cpu');
  const watchIndex = process.argv.indexOf('--watch');

  if (cpuIndex !== -1) {
    const secs = Math.max(5, Number(process.argv[cpuIndex + 1]) || 30);
    process.exit(reportCpu(secs) ? 0 : 2);
  }

  if (watchIndex === -1) {
    process.exit(report(asJson, withVmmap) ? 0 : 2);
  }

  const every = Math.max(1, Number(process.argv[watchIndex + 1]) || 5) * 1000;
  const tick = () => {
    if (!asJson) console.log('  ' + new Date().toTimeString().slice(0, 8));
    report(asJson, withVmmap);
  };
  tick();
  setInterval(tick, every);
}

main();
