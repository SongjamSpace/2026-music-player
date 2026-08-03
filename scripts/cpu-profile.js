#!/usr/bin/env node
'use strict';

/**
 * Captures a V8 CPU profile from the running main process and reports where the
 * time actually goes.
 *
 * `sample(1)` is not enough for this app: every hot frame is JIT-compiled
 * JavaScript, so it symbolises as a bare address and tells you only "it's in JS"
 * — which is the part you already knew. The V8 profiler names the function and
 * the line.
 *
 * The main process must have its inspector open first:
 *
 *   kill -USR1 <main pid>          # then this script
 *   node scripts/cpu-profile.js [seconds]
 *
 * The inspector port closes when the app exits. Nothing here changes app state
 * beyond enabling the profiler for the duration of the capture.
 */

const http = require('http');
const WebSocket = require('ws');

const SECONDS = Math.max(3, Number(process.argv[2]) || 20);
const PORT = Number(process.env.MP_INSPECT_PORT) || 9229;

function targets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('inspector returned unparseable JSON'));
        }
      });
    });
    req.on('error', () =>
      reject(new Error('no inspector on 127.0.0.1:' + PORT + ' — send SIGUSR1 to the main process first'))
    );
    req.setTimeout(3000, () => req.destroy(new Error('inspector timed out')));
  });
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, send }));
    ws.on('error', reject);
  });
}

/**
 * Aggregate self-time per function.
 *
 * `timeDeltas[i]` is the time spent before `samples[i]` was taken, so it is
 * charged to that sample's node — that node's *self* time. Summing self time is
 * what identifies the code actually running, as opposed to the callers sitting
 * above it on the stack.
 */
function selfTime(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  let total = 0;

  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const dt = (profile.timeDeltas[i] || 0) / 1000; // µs → ms
    if (dt < 0) continue;
    total += dt;
    const f = node.callFrame;
    const where = f.url
      ? f.url.replace(/^file:\/\//, '').replace(process.cwd() + '/', '') + ':' + (f.lineNumber + 1)
      : '(native)';
    const key = (f.functionName || '(anonymous)') + '  @ ' + where;
    totals.set(key, (totals.get(key) || 0) + dt);
  }
  return { totals, total };
}

async function main() {
  const list = await targets();
  const target = list.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error('inspector exposed no debuggable target');

  const { ws, send } = await connect(target.webSocketDebuggerUrl);
  await send('Profiler.enable');
  // 1 ms is plenty and keeps the observer effect small.
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  console.log('profiling "' + target.title + '" for ' + SECONDS + 's…');
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const { profile } = await send('Profiler.stop');
  await send('Profiler.disable');
  ws.close();

  const { totals, total } = selfTime(profile);
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  console.log('\n  self time over ' + total.toFixed(0) + 'ms of samples\n');
  console.log('  ' + 'self'.padStart(9) + '  ' + 'share'.padStart(6) + '  function');
  let shown = 0;
  for (const [key, ms] of rows) {
    const pct = (ms / total) * 100;
    if (pct < 0.5 || shown >= 30) break;
    shown++;
    console.log('  ' + (ms.toFixed(0) + 'ms').padStart(9) + '  ' + (pct.toFixed(1) + '%').padStart(6) + '  ' + key);
  }

  // "(program)" and "(idle)" dominating means the time is not in JS at all.
  const idle = rows.find(([k]) => k.startsWith('(idle)'));
  const program = rows.find(([k]) => k.startsWith('(program)'));
  console.log('');
  if (idle) console.log('  idle: ' + ((idle[1] / total) * 100).toFixed(1) + '%');
  if (program) console.log('  (program) — native/GC, not attributable to JS: ' +
    ((program[1] / total) * 100).toFixed(1) + '%');
  console.log('');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
