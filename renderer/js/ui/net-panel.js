(function () {
  'use strict';

  /**
   * Per-torrent connection detail, collapsed by default.
   *
   * The numbers are secondary to the interpretation. "38 peers" tells you
   * nothing on its own; "38 peers, 0 inbound" tells you your router isn't
   * forwarding, and "3 peers, all seeds, unchoked" tells you the swarm is just
   * small and there is nothing to fix. That verdict line is the reason this
   * panel exists — everything else is supporting evidence.
   */

  var POLL_MS = 2000;

  var root, toggleBtn, body, verdictEl, ratesEl, peersEl, transportEl, strategyEl, reachEl, reachBtn;
  var memoryEl;
  var currentId = null;
  var timer = null;
  var open = false;
  var reach = null; // last probe result, cleared on selection change

  function fmtRate(n) {
    return MP.util.formatSpeed(n || 0);
  }

  /**
   * Name the bottleneck, or say plainly that there isn't one to fix.
   * Ordered most-actionable first.
   */
  function verdict(diag) {
    var t = diag && diag.torrent;
    if (!t) return { text: 'Not connected yet.', cls: '' };

    // Outranks everything, including "complete": traffic leaving in the clear
    // on someone else's network is the one thing here with consequences beyond
    // download speed.
    var np = diag.netPath || {};
    var egress = (diag.netPath && diag.netPath.egress) || null;
    if (egress && !egress.tunnel && np.home && np.homeMatch === false) {
      return {
        text: 'Torrent traffic is going direct on an unrecognised network. Anyone on this ' +
          'network, and whoever runs it, can see it.',
        cls: 'is-bad',
      };
    }

    if (t.done) return { text: 'Complete — seeding.', cls: 'is-good' };

    var p = t.peers;
    var nat = diag.nat || {};

    if (p.total === 0) {
      // Don't guess at "the swarm may be empty" when a probe has actually
      // looked — it would sit directly above a line proving the opposite.
      if (reach && !reach.error && reach.addresses > 0) {
        return {
          text: 'Not connected to anyone right now, though ' + reach.addresses + ' peers exist' +
            (reach.dialable ? ' and ' + reach.dialable + ' were reachable a moment ago' : '') +
            '. Peers on a small swarm come and go; it should reconnect.',
          cls: 'is-warn',
        };
      }
      return { text: 'No peers found. The swarm may be empty, or trackers are unreachable.', cls: 'is-bad' };
    }
    // Only claim the port isn't reachable if nothing has *ever* connected in.
    // A live count of zero proves nothing — peers come and go constantly — and
    // telling someone their working port forward is broken sends them off to
    // fix something that isn't wrong.
    //
    // Keyed on the detected egress rather than nat.reachability, because when
    // the listen port falls back to ephemeral the router mapping is skipped
    // entirely and nat never populates — which used to leave this blaming the
    // router on a machine where the router isn't even in the path.
    if (p.inbound === 0 && !diag.inboundPeak) {
      var port = diag.client.torrentPort || '?';
      if (egress && egress.tunnel) {
        return {
          text: 'No incoming connections yet on port ' + port +
            ". If your VPN forwards a port, check Settings matches it — without one, small " +
            'swarms like this stall.',
          cls: 'is-warn',
        };
      }
      if (nat.reachability === 'cgnat') {
        return {
          text: 'No incoming connections — your ISP shares one address between customers, so ' +
            'peers cannot reach you. This caps your speed.',
          cls: 'is-warn',
        };
      }
      if (!nat.mapped) {
        return {
          text: "No incoming connections — nothing is forwarding port " + port +
            ' to this machine. This is capping your speed.',
          cls: 'is-bad',
        };
      }
    }
    if (p.unchokedByPeer === 0) {
      return { text: 'Connected, but no peer is sending yet. Usually resolves in a minute.', cls: 'is-warn' };
    }
    if (p.total <= 4 && p.unchokedByPeer === p.total) {
      return { text: 'Small swarm, and everyone in it is already sending to you. This is as fast as it gets.', cls: 'is-good' };
    }
    if (p.unchokedByPeer < p.total / 4 && p.total > 8) {
      return {
        text: 'Most peers are holding back. Raising your upload limit in Settings usually fixes this.',
        cls: 'is-warn',
      };
    }
    // The case nothing else can distinguish: plenty of peers known, none of
    // them contactable. Only assertable once the probe has actually run.
    if (reach && !reach.error && reach.sampled > 0 && reach.dialable === 0) {
      return {
        text: reach.addresses + ' peers known, none reachable — every one is behind a NAT that ' +
          "won't accept connections, and so are you. That is why this sits at 0 B/s.",
        cls: 'is-bad',
      };
    }

    // Last, deliberately: an expectation mismatch is worth saying, but never at
    // the cost of hiding a bottleneck the user could actually act on.
    if (egress && egress.tunnel && (np.expected === 'direct' || np.expected === 'vpn-preferred')) {
      return {
        text: 'Downloading, but through the VPN rather than the direct path you expect — ' +
          'see Settings → Network.',
        cls: 'is-warn',
      };
    }
    return { text: 'Downloading from ' + p.unchokedByPeer + ' of ' + p.total + ' peers.', cls: 'is-good' };
  }

  function paint(diag) {
    if (!diag || !diag.torrent) {
      verdictEl.textContent = 'Not connected yet.';
      return;
    }
    var t = diag.torrent;
    var p = t.peers;

    var v = verdict(diag);
    verdictEl.textContent = v.text;
    verdictEl.className = 'net-panel__verdict ' + v.cls;

    ratesEl.textContent = '↓ ' + fmtRate(t.downloadSpeed) + '   ↑ ' + fmtRate(t.uploadSpeed);

    // Show the session peak alongside the live count: the live one dips to zero
    // constantly, and "0 inbound" on its own reads as a broken port forward.
    var peak = diag.inboundPeak || 0;
    peersEl.textContent =
      p.total + (p.total === 1 ? ' peer' : ' peers') +
      ' (' + p.seeds + ' seed' + (p.seeds === 1 ? '' : 's') + ' · ' + p.leechers + ' leech)' +
      ' · ' + p.inbound + ' inbound' + (peak > p.inbound ? ' (peak ' + peak + ')' : '');

    // `|| 0` because the panel may poll a main process still running the
    // previous build during development.
    var tcp = p.tcpIn + p.tcpOut;
    transportEl.textContent =
      'TCP ' + tcp + (tcp ? ' (' + (p.encrypted || 0) + ' encrypted)' : '') +
      ' · uTP ' + (p.utpIn + p.utpOut) + ' · web ' + p.webSeed +
      ' · ' + p.unchokedByPeer + ' sending';

    var egress = (diag.netPath && diag.netPath.egress) || null;
    strategyEl.textContent =
      (egress ? 'Path: ' + (egress.tunnel ? 'VPN ' : 'direct ') + egress.iface + ' · ' : '') +
      'order ' + (t.strategy === 'rarest' ? 'rarest first' : 'sequential') +
      ' · ' + t.selections + ' priority ranges';

    paintReach();
  }

  function paintReach() {
    if (!reach) {
      reachEl.textContent = '';
      reachEl.hidden = true;
      return;
    }
    reachEl.hidden = false;
    if (reach.error) {
      reachEl.textContent = 'Reachability check failed: ' + reach.error;
      reachEl.className = 'net-panel__row is-warn';
      return;
    }
    var pct = reach.sampled ? Math.round((100 * reach.dialable) / reach.sampled) : 0;
    reachEl.textContent =
      reach.addresses + ' peers known · ' + reach.dialable + ' of ' + reach.sampled +
      ' reachable (' + pct + '%)' +
      '  · tracker says ' + reach.seeders + ' seeds / ' + reach.leechers + ' leech' +
      (reach.fastest != null ? ' · fastest ' + reach.fastest + 'ms' : '');
    reachEl.className = 'net-panel__row ' + (reach.dialable ? 'is-good' : 'is-bad');
  }

  function runReach() {
    if (!currentId) return;
    reachBtn.disabled = true;
    reachBtn.textContent = 'Checking…';
    reachEl.hidden = false;
    reachEl.className = 'net-panel__row';
    reachEl.textContent = 'Asking trackers, then trying to connect to each peer…';
    window.playerAPI.probeSwarm(currentId).then(function (r) {
      reachBtn.disabled = false;
      reachBtn.textContent = 'Check reachability';
      reach = r;
      paintReach();
      refresh();
    });
  }

  /**
   * Memory, because "why is this app using 2 GB" was not answerable from inside
   * the app at all — and it is the question that matters most as the library
   * grows. `liveTorrents` next to the footprint is the important pairing: it is
   * what shows whether cost tracks what is actually active or just how much music
   * has ever been added.
   */
  function paintMemory(m) {
    if (!m) {
      memoryEl.textContent = '';
      return;
    }
    var fmt = MP.util.formatBytes;
    var totalFootprint = (m.processes || []).reduce(function (n, p) {
      return n + (p.footprintBytes || 0);
    }, 0);
    var t = m.torrents || {};

    memoryEl.textContent =
      'Memory ' + fmt(totalFootprint || m.main.rssBytes) +
      ' (heap ' + fmt(m.main.heapUsedBytes) +
      ', buffers ' + fmt(m.main.arrayBuffersBytes || 0) + ')' +
      ' · ' + (t.liveTorrents || 0) + ' live · ' + (t.totalWires || 0) + ' wires' +
      // Started-but-unfinished pieces are the number that matters here: each holds
      // 16 KB block buffers outside the JS heap, which is how the process can grow
      // while the heap stays flat. It climbs when the picker starts pieces it does
      // not finish.
      ' · ' + (t.startedPieces || 0) + ' started pieces (' + fmt(t.startedPieceBytes || 0) + ')' +
      ' · cache ≤' + fmt(t.predictedCacheBytes || 0) +
      ' · loop lag ' + (m.main.maxEventLoopLagMs || 0) + 'ms';

    // The event loop is the thing that beachballs, so flag it rather than leaving
    // the number to be read.
    memoryEl.className =
      'net-panel__row ' +
      (m.main.maxEventLoopLagMs > 1000 ? 'is-bad' : m.main.maxEventLoopLagMs > 250 ? 'is-warn' : '');
  }

  function refresh() {
    if (!currentId) return;
    window.playerAPI.getDiagnostics(currentId).then(paint);
    // Independent of the per-torrent diagnostics: memory is a property of the
    // process, not of whatever happens to be selected.
    window.playerAPI.getMetrics().then(paintMemory).catch(function () {});
  }

  function setOpen(next) {
    open = next;
    body.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    clearInterval(timer);
    timer = null;
    if (open) {
      refresh();
      timer = setInterval(refresh, POLL_MS);
    }
    window.playerAPI.setPref('showNetPanel', open);
  }

  function onSelection(id) {
    currentId = id;
    // A reachability result belongs to one swarm; carrying it across would be
    // worse than showing nothing.
    reach = null;
    if (open) refresh();
  }

  function init(mountPoint) {
    root = MP.util.el('div', 'net-panel');

    toggleBtn = MP.util.el('button', 'net-panel__toggle');
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = 'Connection';
    toggleBtn.addEventListener('click', function () { setOpen(!open); });

    body = MP.util.el('div', 'net-panel__body');
    body.hidden = true;

    verdictEl = MP.util.el('div', 'net-panel__verdict');
    ratesEl = MP.util.el('div', 'net-panel__row');
    peersEl = MP.util.el('div', 'net-panel__row');
    transportEl = MP.util.el('div', 'net-panel__row');
    strategyEl = MP.util.el('div', 'net-panel__row');
    memoryEl = MP.util.el('div', 'net-panel__row');
    memoryEl.title =
      'Memory this app is using, and what the torrent engine is holding. ' +
      'Piece cache is a worst-case ceiling, not a reading.';
    reachEl = MP.util.el('div', 'net-panel__row');
    reachEl.hidden = true;

    reachBtn = MP.util.el('button', 'btn btn--secondary net-panel__action', 'Check reachability');
    reachBtn.type = 'button';
    reachBtn.title = 'Ask the trackers who is in this swarm, then try to connect to each of them';
    reachBtn.addEventListener('click', runReach);

    [verdictEl, ratesEl, peersEl, transportEl, strategyEl, memoryEl, reachEl, reachBtn].forEach(function (n) {
      body.appendChild(n);
    });
    root.appendChild(toggleBtn);
    root.appendChild(body);
    mountPoint.appendChild(root);

    MP.store.subscribe('selection', onSelection);
    currentId = MP.store.state.selectedTorrentId;

    if (MP.store.state.settings.showNetPanel) setOpen(true);
  }

  window.MP.netPanel = { init: init };
})();
