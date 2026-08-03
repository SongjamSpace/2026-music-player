#!/usr/bin/env node
'use strict';

/**
 * End-to-end check that a downloaded album plays from disk, not through webtorrent.
 *
 * This is the one thing the other harnesses cannot answer. range-check.js proves
 * the file server speaks HTTP correctly and library-cost-check.js proves the engine
 * is cheap, but neither proves that Chromium's media stack actually decodes what we
 * serve — and the failure mode there is silent: audio that loads but will not seek,
 * or a CORS-tainted element that plays through the DSP graph as silence.
 *
 * So it drives the real renderer over CDP: picks a track that has a local URL,
 * plays it, reads the media element's own state, then seeks to 80% and checks the
 * play head really moved. It leaves playback paused.
 *
 * Needs the app running with a renderer debugging port:
 *
 *   npm run dev:debug          # electron . --remote-debugging-port=9222
 *   node scripts/playback-check.js
 *
 * Not part of `npm run check`, which is deliberately no-network and no-running-app.
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.MP_DEBUG_PORT) || 9222;
const LOAD_WAIT_MS = 6000;
const SEEK_WAIT_MS = 3000;

let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(50) + (detail == null ? '' : detail));
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (err) {
          reject(new Error('debug port returned unparseable JSON'));
        }
      });
    });
    req.on('error', () =>
      reject(
        new Error(
          'no renderer debug port on 127.0.0.1:' + PORT + '\n' +
            '  start the app with: npm run dev:debug'
        )
      )
    );
    req.setTimeout(3000, () => req.destroy(new Error('debug port timed out')));
  });
}

async function connect() {
  const targets = await get('/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
  if (!page) throw new Error('renderer page not found on the debug port');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = id++;
      pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  };
  return { ws, evaluate };
}

const MEDIA_STATE = `
  (() => {
    const el = document.getElementById('audio-player');
    return {
      currentSrc: el.currentSrc,
      currentTime: el.currentTime,
      duration: el.duration,
      readyState: el.readyState,
      paused: el.paused,
      error: el.error ? el.error.code : null,
    };
  })()
`;

async function main() {
  const { ws, evaluate } = await connect();

  const survey = await evaluate(`
    (() => {
      const out = [];
      MP.store.state.torrents.forEach((t) => {
        const files = t.files || [];
        out.push({
          name: (t.name || '').slice(0, 40),
          done: !!t.done,
          playable: files.filter((f) => MP.util.isPlayable(f)).length,
          withLocal: files.filter((f) => f.localURL).length,
        });
      });
      return out;
    })()
  `);

  console.log('\n  library as the renderer sees it:');
  survey.forEach((t) =>
    console.log(
      '    ' + (t.done ? 'done ' : 'part ') +
        String(t.playable).padStart(4) + ' playable ' +
        String(t.withLocal).padStart(4) + ' local   ' + t.name
    )
  );
  console.log('');

  check('at least one album resolves local URLs', survey.some((t) => t.withLocal > 0));

  const picked = await evaluate(`
    (() => {
      let found = null;
      MP.store.state.torrents.forEach((t) => {
        if (found) return;
        (t.files || []).forEach((f, i) => {
          if (found || !f.localURL || !MP.util.isPlayable(f)) return;
          found = { id: t.id, index: i, name: f.name, url: f.localURL };
        });
      });
      if (found) MP.player.play(found.id, found.index);
      return found;
    })()
  `);

  if (!picked) {
    console.log('\n  no playable track has a local URL yet — cannot verify\n');
    ws.close();
    process.exit(2);
  }

  console.log('  playing: ' + picked.name);
  await new Promise((r) => setTimeout(r, LOAD_WAIT_MS));
  const before = await evaluate(MEDIA_STATE);

  check('media element loaded the local URL', before.currentSrc === picked.url);
  // 4 is HAVE_ENOUGH_DATA. Anything less after six seconds on a local file means
  // the server is not answering the way Chromium needs.
  check('readyState is 4 (can play through)', before.readyState === 4, 'readyState=' + before.readyState);
  check('no media error', before.error === null, before.error === null ? '' : 'code=' + before.error);
  check('play head advanced', before.currentTime > 0, before.currentTime.toFixed(2) + 's');
  check('duration known', isFinite(before.duration) && before.duration > 0, (before.duration || 0).toFixed(1) + 's');

  // Seeking is the part that depends on 206 and a correct Content-Range. Audio
  // that plays but cannot seek is the exact symptom of getting that wrong.
  const target = Math.max(0, (before.duration || 60) * 0.8);
  await evaluate(`document.getElementById('audio-player').currentTime = ${target}`);
  await new Promise((r) => setTimeout(r, SEEK_WAIT_MS));
  const after = await evaluate(MEDIA_STATE);

  check('seek moved the play head', after.currentTime > before.currentTime + 1,
    after.currentTime.toFixed(2) + 's');
  check('still playable after seeking', after.readyState >= 3, 'readyState=' + after.readyState);
  check('no error after seeking', after.error === null, after.error === null ? '' : 'code=' + after.error);

  // Don't leave music playing at whoever ran this.
  await evaluate(`document.getElementById('audio-player').pause()`);
  ws.close();

  console.log('\n' + (failures ? '  ' + failures + ' FAILED' : '  all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
