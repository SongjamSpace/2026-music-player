(function () {
  'use strict';

  var addDlg, addForm, addField, addHint, addSubmit;
  var settingsDlg, confirmDlg, shortcutsDlg, promptDlg;

  // -- add magnet ----------------------------------------------------------

  function openAddMagnet(prefill) {
    addField.value = prefill || '';
    addHint.textContent = 'Paste the whole page if you like — the magnet link is picked out of it.';
    addHint.classList.remove('is-error');
    addDlg.showModal();
    addField.focus();
  }

  function submitAdd(e) {
    e.preventDefault();
    var raw = addField.value;
    addSubmit.disabled = true;
    MP.actions
      .addMagnet(raw)
      .then(function () {
        // Close immediately: fetching metadata can take minutes and must never
        // block the UI behind a modal.
        addDlg.close();
      })
      .catch(function (err) {
        addHint.textContent = err && err.message ? err.message : String(err);
        addHint.classList.add('is-error');
      })
      .finally(function () {
        addSubmit.disabled = false;
      });
  }

  // -- confirm -------------------------------------------------------------

  function confirm(opts) {
    return new Promise(function (resolve) {
      confirmDlg.querySelector('.dialog__title').textContent = opts.title;
      confirmDlg.querySelector('.dialog__body').textContent = opts.body;
      var ok = confirmDlg.querySelector('.js-confirm');
      ok.textContent = opts.confirmLabel || 'Confirm';
      ok.className = 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary');

      var done = function (value) {
        confirmDlg.removeEventListener('close', onClose);
        ok.removeEventListener('click', onOk);
        resolve(value);
      };
      var onOk = function () { confirmDlg.close('ok'); };
      var onClose = function () { done(confirmDlg.returnValue === 'ok'); };

      ok.addEventListener('click', onOk);
      confirmDlg.addEventListener('close', onClose);
      confirmDlg.returnValue = '';
      confirmDlg.showModal();
      ok.focus();
    });
  }

  // -- prompt ----------------------------------------------------------------

  /** Resolves with the trimmed string, or null if cancelled. */
  function prompt(opts) {
    return new Promise(function (resolve) {
      promptDlg.querySelector('.dialog__title').textContent = opts.title;
      var label = promptDlg.querySelector('.field__label');
      label.textContent = opts.label || '';
      var input = promptDlg.querySelector('#prompt-input');
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      var ok = promptDlg.querySelector('.js-prompt-ok');
      ok.textContent = opts.confirmLabel || 'Save';

      var done = function (value) {
        promptDlg.removeEventListener('close', onClose);
        resolve(value);
      };
      var onClose = function () {
        done(promptDlg.returnValue === 'ok' ? input.value.trim() || null : null);
      };
      promptDlg.addEventListener('close', onClose);
      promptDlg.returnValue = '';
      promptDlg.showModal();
      input.focus();
      input.select();
    });
  }

  // -- settings ------------------------------------------------------------

  function buildThemePicker(container) {
    container.textContent = '';
    MP.theme.list().forEach(function (theme) {
      var label = MP.util.el('label', 'theme-swatch');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'theme';
      input.value = theme.id;
      input.checked = MP.theme.get() === theme.id;
      input.addEventListener('change', function () { MP.theme.set(theme.id); });

      // The preview renders inside the theme it represents, so it stays honest
      // for any theme added later without touching this code.
      var preview = MP.util.el('span', 'theme-swatch__preview');
      preview.dataset.theme = theme.id;
      var side = MP.util.el('span');
      side.style.background = 'var(--color-bg-sidebar)';
      var body = MP.util.el('span');
      body.style.background = 'var(--color-bg-content)';
      preview.appendChild(side);
      preview.appendChild(body);

      label.appendChild(input);
      label.appendChild(preview);
      label.appendChild(MP.util.el('span', 'theme-swatch__name', theme.label));
      container.appendChild(label);
    });
  }

  function bindSwitch(node, initial, onChange) {
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-checked', initial ? 'true' : 'false');
    node.addEventListener('click', function () {
      var next = node.getAttribute('aria-checked') !== 'true';
      node.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
  }

  // -- network status --------------------------------------------------------

  var netTimer = null;
  var NET_POLL_MS = 2000;
  // Kept so the expectation confirm dialog can consult homeMatch without
  // waiting on another round trip.
  var lastNetPath = null;

  /**
   * Turn the port-mapping state into something the user can act on. "UPnP
   * failed" is not actionable; "your router at 192.168.1.1 isn't advertising
   * UPnP" is. Note that a router acknowledging a mapping proves nothing — the
   * real evidence is inbound peers, which the connection panel shows.
   */
  function paintNet(diag) {
    if (!diag) return;
    var nat = diag.nat || {};
    var value = settingsDlg.querySelector('#net-mapping');
    var desc = settingsDlg.querySelector('#net-mapping-desc');

    value.classList.remove('is-good', 'is-warn', 'is-bad');
    if (diag.portFallback) {
      value.textContent = 'Off — port ' + diag.portFallback + ' was already in use';
      value.classList.add('is-warn');
      desc.textContent =
        'Another copy of this app (or another program) is holding that port, so a temporary one ' +
        'is in use instead. Quit the other copy and restart, or pick a different port.';
    } else if (nat.skipped === 'tunnel') {
      // Traffic egresses a tunnel, so the LAN router is not in the path at all
      // and its port mapping is irrelevant. What matters is whether the VPN
      // provider forwards a port — and the only honest evidence for that is
      // peers actually connecting in, so that is what gets reported.
      var port = (diag.client && diag.client.torrentPort) || '?';
      var seen = diag.inboundPeak || 0;
      if (seen > 0) {
        value.textContent = "Using your VPN's forwarded port";
        value.classList.add('is-good');
        desc.textContent =
          seen + (seen === 1 ? ' peer has' : ' peers have') + ' connected in on port ' + port +
          ". Your router isn't involved — the VPN forwards this port to this machine.";
      } else {
        value.textContent = 'No incoming connections yet on port ' + port;
        value.classList.add('is-warn');
        desc.textContent =
          'Traffic leaves through ' + ((nat.egress && nat.egress.iface) || 'a VPN') +
          ', so your router cannot help. If this persists, check that the forwarded port in ' +
          'your VPN account still matches the listen port below.';
      }
    } else if (nat.mapped && nat.reachability === 'cgnat') {
      value.textContent = 'Mapped, but your ISP uses carrier-grade NAT';
      value.classList.add('is-warn');
      desc.textContent = nat.hint;
    } else if (nat.mapped && nat.reachability === 'private-external') {
      value.textContent = 'Mapped, but there is a second router in front';
      value.classList.add('is-warn');
      desc.textContent = nat.hint;
    } else if (nat.mapped) {
      value.textContent = 'Mapped via ' + (nat.method === 'upnp' ? 'UPnP' : 'NAT-PMP');
      value.classList.add('is-good');
      desc.textContent = 'Ports ' + nat.mappedPorts.join(' and ') + ' are forwarded to this Mac.';
    } else {
      value.textContent = 'Not mapped — peers cannot connect to you';
      value.classList.add('is-bad');
      desc.textContent = nat.hint || 'Forward this app\'s listen port to this Mac in your router settings.';
    }

    paintPort(diag);

    var parts = [];
    if (nat.externalIp) parts.push('Router WAN ' + nat.externalIp);
    if (nat.egress && nat.egress.tunnel) parts.push('egress via ' + nat.egress.iface);
    var client = diag.client || {};
    if (client.dhtNodes != null) parts.push(client.dhtNodes + ' DHT nodes');
    if (diag.trackers) parts.push(diag.trackers.count + ' trackers (' + diag.trackers.source + ')');
    settingsDlg.querySelector('#net-external').textContent = parts.join(' · ') || '—';
  }

  /**
   * The port row. The pref and the port actually bound diverge until a restart,
   * and that gap has to be visible — silently accepting a new port while still
   * listening on the old one is how you end up debugging a working config.
   */
  function paintPort(diag) {
    var el = settingsDlg.querySelector('#net-port');
    var input = settingsDlg.querySelector('#input-listen-port');
    var client = diag.client || {};
    var pref = MP.store.state.settings.torrentPort;
    var live = client.torrentPort;

    // Don't fight the user mid-edit.
    if (document.activeElement !== input && pref != null) input.value = String(pref);

    if (diag.portFallback) {
      // Say what will happen next as well as what went wrong — otherwise a port
      // the user just changed looks like it was ignored.
      set(
        el,
        'Listening on a temporary port — ' + diag.portFallback + ' was taken' +
          (pref != null && pref !== diag.portFallback ? ' · will try ' + pref + ' after restart' : ''),
        'is-bad'
      );
    } else if (pref != null && live && pref !== live) {
      set(el, live + ' now · ' + pref + ' after restart', 'is-warn');
    } else if (live) {
      set(el, live + (client.dhtPort ? ' · DHT ' + client.dhtPort : ''), 'is-good');
    } else {
      set(el, '—', '');
    }
  }

  // -- traffic path ----------------------------------------------------------

  function ifaceLabel(np, tunnel) {
    var egress = np.egress;
    if (egress && egress.iface) return egress.iface + ' (' + egress.address + ')';
    var match = (np.candidates || []).filter(function (c) {
      return tunnel ? c.kind === 'tunnel' : c.kind === 'physical';
    })[0];
    return match ? match.name + ' (' + match.address + ')' : 'unknown';
  }

  function set(el, text, cls) {
    el.textContent = text;
    el.className = 'setting-row__value' + (cls ? ' ' + cls : '');
  }

  function paintPath(np) {
    var pathEl = settingsDlg.querySelector('#net-path-actual');
    var descEl = settingsDlg.querySelector('#net-path-actual-desc');
    var defaultDesc =
      "Where macOS is currently sending this app's traffic. This app cannot pick an interface — " +
      'the system routing table decides that, for torrents and everything else alike.';

    var egress = np.egress;
    if (!egress) {
      set(pathEl, 'Unknown', 'is-warn');
      descEl.textContent = defaultDesc;
      return;
    }

    var tunnel = !!egress.tunnel;
    var v = MP.util.pathVerdict(np.expected || 'auto', tunnel, !!np.tunnelAvailable);

    // Going direct on a network the user hasn't vouched for outranks every
    // expectation verdict — including the ones that would otherwise read as
    // success.
    if (!tunnel && np.home && np.homeMatch === false) {
      set(pathEl, 'Direct — ' + ifaceLabel(np, false) + ' · unrecognised network', 'is-bad');
      descEl.textContent =
        "Torrent traffic is going out directly on a network you haven't marked as home. " +
        'Anyone on this network, and whoever runs it, can see it.';
      return;
    }

    set(pathEl, (tunnel ? 'VPN — ' : 'Direct — ') + ifaceLabel(np, tunnel), v.cls);

    // The expected interface exists but has no route — the split-tunnel-not-live
    // case, and the single most useful thing this panel can tell you.
    var wantPhysical = np.expected === 'direct' || np.expected === 'vpn-preferred';
    var pf = np.preflight && np.preflight.results;
    var stranded = null;
    if (wantPhysical && pf) {
      Object.keys(pf).forEach(function (name) {
        if (pf[name].kind === 'physical' && !pf[name].reachable) stranded = pf[name];
      });
    }
    if (stranded && tunnel) {
      descEl.textContent =
        stranded.name + ' is up but has no route to the internet (' + stranded.code + ') — ' +
        'your split tunnel is not live yet.';
      return;
    }
    descEl.textContent = v.desc || defaultDesc;
  }

  function paintPreflight(np) {
    var el = settingsDlg.querySelector('#net-preflight');
    var pf = np.preflight;
    if (!pf || !pf.results || !Object.keys(pf.results).length) {
      set(el, 'Not tested', '');
      return;
    }
    var anyPhysicalDead = false;
    var parts = Object.keys(pf.results).map(function (name) {
      var r = pf.results[name];
      if (r.kind === 'physical' && !r.reachable) anyPhysicalDead = true;
      return name + ' ' + (r.reachable ? 'reachable ' + r.ms + 'ms' : 'no route (' + r.code + ')');
    });
    set(el, parts.join(' · '), anyPhysicalDead ? 'is-warn' : 'is-good');
  }

  function paintHome(np) {
    var el = settingsDlg.querySelector('#net-home');
    var btn = settingsDlg.querySelector('#btn-home-network');
    if (np.home && np.homeMatch) {
      set(el, 'Recognised — router ' + np.home.gatewayMac, 'is-good');
      btn.textContent = 'Forget';
    } else if (np.home) {
      // An unfamiliar network is not itself an error, so no colour here — the
      // warning belongs on the traffic path row, where it has consequences.
      set(el, 'Not this one — saved router ' + np.home.gatewayMac, '');
      btn.textContent = 'Remember this network';
    } else {
      set(el, np.network ? 'Not saved — router ' + np.network.gatewayMac : 'Not recognised', '');
      btn.textContent = 'Remember this network';
    }
  }

  function paintEncryption(diag) {
    var el = settingsDlg.querySelector('#net-encryption');
    var sw = settingsDlg.querySelector('#switch-encryption');
    var pref = MP.store.state.settings.peerEncryption !== false;
    var effective = !!(diag.client && diag.client.secure);
    sw.setAttribute('aria-checked', pref ? 'true' : 'false');

    if (pref !== effective) {
      set(el, (pref ? 'On' : 'Off') + ' after restart — currently ' + (effective ? 'on' : 'off'), 'is-warn');
      return;
    }
    var p = diag.torrent && diag.torrent.peers;
    if (effective && p && p.encryptable) {
      // Reported out of encryptable, not total: a peer that refuses encryption
      // is retried in the clear, so this never reaches 100% and shouldn't look
      // like it is failing to.
      set(el, 'On · ' + p.encrypted + ' of ' + p.encryptable + ' TCP peers encrypted', 'is-good');
    } else {
      set(el, effective ? 'On' : 'Off', effective ? 'is-good' : '');
    }
  }

  function paintUtp(diag) {
    var el = settingsDlg.querySelector('#net-utp');
    var sw = settingsDlg.querySelector('#switch-utp');
    if (!el || !sw) return;
    var pref = MP.store.state.settings.enableUtp === true;
    var effective = !!(diag.client && diag.client.utp);
    sw.setAttribute('aria-checked', pref ? 'true' : 'false');

    if (pref !== effective) {
      set(el, (pref ? 'On' : 'Off') + ' after restart — currently ' + (effective ? 'on' : 'off'), 'is-warn');
      return;
    }
    if (!effective) {
      set(el, 'Off — TCP only', '');
      return;
    }
    // Deliberately not 'is-good' when on: this is the setting that crashes.
    var p = diag.torrent && diag.torrent.peers;
    var n = p ? (p.utpIn || 0) + (p.utpOut || 0) : 0;
    set(el, 'On · ' + n + ' µTP peers · may crash', 'is-warn');
  }

  function refreshNet() {
    window.playerAPI.getDiagnostics(MP.store.state.selectedTorrentId).then(function (diag) {
      if (!diag) return;
      paintNet(diag);
      var np = diag.netPath;
      if (np) {
        lastNetPath = np;
        paintPath(np);
        paintPreflight(np);
        paintHome(np);
        settingsDlg.querySelector('#select-expected-path').value = np.expected || 'auto';
      }
      paintEncryption(diag);
      paintUtp(diag);
    });
  }

  function openSettings() {
    var s = MP.store.state.settings;
    settingsDlg.querySelector('#settings-path').textContent = s.downloadPath || '—';
    settingsDlg.querySelector('#settings-version').textContent = s.version ? 'Version ' + s.version : '';
    settingsDlg.querySelector('#settings-count').textContent =
      MP.store.state.torrentOrder.length + ' in library';
    buildThemePicker(settingsDlg.querySelector('#theme-picker'));

    settingsDlg.querySelector('#select-upload-limit').value = String(s.uploadLimit != null ? s.uploadLimit : 1500000);
    settingsDlg.querySelector('#select-piece-strategy').value = s.pieceStrategy || 'auto';

    refreshNet();
    // One real probe per dialog opening; the poll below reads cached state.
    window.playerAPI.runNetPreflight().then(refreshNet);
    // Only while the dialog is open — there is no reason to poll main for
    // diagnostics nobody is looking at.
    clearInterval(netTimer);
    netTimer = setInterval(refreshNet, NET_POLL_MS);

    settingsDlg.showModal();
  }

  function onSettingsClosed() {
    clearInterval(netTimer);
    netTimer = null;
    // Drop the public IP rather than leaving it on screen: it was true for one
    // network at one moment, and reading a stale address as current is exactly
    // the mistake this whole panel exists to prevent.
    set(settingsDlg.querySelector('#net-public-ip'), '—', '');
    window.playerAPI.clearPublicIp();
  }

  function closeSettings() {
    settingsDlg.close();
  }

  function initSettings() {
    settingsDlg = document.getElementById('settings-dialog');

    settingsDlg.querySelector('#btn-change-path').addEventListener('click', function () {
      window.playerAPI.chooseDownloadPath().then(function (r) {
        if (r.canceled) return;
        MP.store.state.settings.downloadPath = r.path;
        settingsDlg.querySelector('#settings-path').textContent = r.path;
        MP.toast.show('New downloads will be saved here. Existing torrents keep their current location.');
      });
    });

    settingsDlg.querySelector('#btn-reveal-path').addEventListener('click', function () {
      MP.actions.openDownloadFolder();
    });

    var durSwitch = settingsDlg.querySelector('#switch-durations');
    bindSwitch(durSwitch, MP.store.state.settings.readDurations, function (on) {
      MP.store.state.settings.readDurations = on;
      window.playerAPI.setPref('readDurations', on);
    });

    settingsDlg.querySelector('#btn-retry-mapping').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      btn.disabled = true;
      settingsDlg.querySelector('#net-mapping').textContent = 'Retrying…';
      window.playerAPI.retryPortMapping().then(function () {
        btn.disabled = false;
        refreshNet();
      });
    });

    settingsDlg.querySelector('#select-upload-limit').addEventListener('change', function (e) {
      var value = Number(e.target.value);
      MP.store.state.settings.uploadLimit = value;
      window.playerAPI.setPref('uploadLimit', value);
    });

    settingsDlg.querySelector('#select-piece-strategy').addEventListener('change', function (e) {
      MP.store.state.settings.pieceStrategy = e.target.value;
      window.playerAPI.setPref('pieceStrategy', e.target.value);
    });

    var expectedSelect = settingsDlg.querySelector('#select-expected-path');
    expectedSelect.addEventListener('change', function (e) {
      var value = e.target.value;
      var previous = MP.store.state.settings.expectedPath || 'auto';
      var apply = function () {
        MP.store.state.settings.expectedPath = value;
        window.playerAPI.setPref('expectedPath', value).then(refreshNet);
      };

      // The app can't refuse to bypass a VPN it doesn't control, so the only
      // honest lever it has on an unfamiliar network is withholding the
      // all-clear — hence a confirmation rather than a block.
      var np = lastNetPath;
      if (value === 'direct' && np && np.homeMatch !== true) {
        MP.dialogs
          .confirm({
            title: 'Expect a direct connection here?',
            body:
              "This network isn't marked as your home network. Expecting a direct path means the " +
              'app stops warning you when torrent traffic bypasses the VPN — which on someone ' +
              "else's network is visible to whoever runs it.",
            confirmLabel: 'Expect direct anyway',
            danger: true,
          })
          .then(function (ok) {
            if (ok) apply();
            else expectedSelect.value = previous;
          });
        return;
      }
      apply();
    });

    var portInput = settingsDlg.querySelector('#input-listen-port');
    var applyPort = function () {
      var n = Number(portInput.value);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        MP.toast.error('Listen port must be a whole number between 1024 and 65535.');
        portInput.value = String(MP.store.state.settings.torrentPort || '');
        return;
      }
      if (n === MP.store.state.settings.torrentPort) return;
      MP.store.state.settings.torrentPort = n;
      window.playerAPI.setPref('torrentPort', n).then(function () {
        MP.toast.show('Listen port set to ' + n + '. Restart the app for it to take effect.');
        refreshNet();
      });
    };
    settingsDlg.querySelector('#btn-apply-port').addEventListener('click', applyPort);
    portInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') applyPort();
    });

    settingsDlg.querySelector('#btn-net-preflight').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      btn.disabled = true;
      settingsDlg.querySelector('#net-preflight').textContent = 'Testing…';
      window.playerAPI.runNetPreflight().then(function () {
        btn.disabled = false;
        refreshNet();
      });
    });

    settingsDlg.querySelector('#btn-public-ip').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      var el = settingsDlg.querySelector('#net-public-ip');
      btn.disabled = true;
      set(el, 'Checking…', '');
      window.playerAPI.checkPublicIp().then(function (r) {
        btn.disabled = false;
        if (!r || r.error) set(el, r && r.error ? r.error : 'Could not check', 'is-warn');
        else set(el, r.ip + ' · via ' + r.via, '');
      });
    });

    settingsDlg.querySelector('#btn-home-network').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      var forgetting = btn.textContent === 'Forget';
      btn.disabled = true;
      var call = forgetting ? window.playerAPI.forgetHomeNetwork() : window.playerAPI.rememberHomeNetwork();
      call.then(function (r) {
        btn.disabled = false;
        if (r && r.error) MP.toast.error(r.error);
        else MP.store.state.settings.homeNetwork = r ? r.home : null;
        refreshNet();
      });
    });

    bindSwitch(settingsDlg.querySelector('#switch-encryption'), MP.store.state.settings.peerEncryption !== false, function (on) {
      MP.store.state.settings.peerEncryption = on;
      window.playerAPI.setPref('peerEncryption', on).then(refreshNet);
    });

    bindSwitch(settingsDlg.querySelector('#switch-utp'), MP.store.state.settings.enableUtp === true, function (on) {
      MP.store.state.settings.enableUtp = on;
      window.playerAPI.setPref('enableUtp', on).then(function () {
        refreshNet();
        MP.toast.show(
          on
            ? 'µTP will be enabled after a restart. If the app starts vanishing, turn it back off.'
            : 'µTP will be disabled after a restart.'
        );
      });
    });

    settingsDlg.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', closeSettings);
    });
    // Esc closes a <dialog> without going through the button, so teardown hangs
    // off the event rather than the click handler.
    settingsDlg.addEventListener('close', onSettingsClosed);
  }

  // -- shortcuts sheet -----------------------------------------------------

  var SHORTCUTS = [
    ['Play / pause', 'Space'],
    ['Seek ±10s', '← →'],
    ['Seek ±30s', '⇧ ← →'],
    ['Previous / next track', '⌘ ← →'],
    ['Volume', '⌘ ↑ ↓'],
    ['Mute', 'M'],
    ['Shuffle', 'S'],
    ['Cycle repeat', 'R'],
    ['Play selected track', '↵'],
    ['Add magnet', '⌘ N'],
    ['Settings', '⌘ ,'],
    ['Find in tracks', '⌘ F'],
    ['Reveal in Finder', '⌘ ⇧ R'],
    ['Fullscreen video', 'F'],
    ['Audio effects', 'E'],
    ['Cycle theme', '⌘ ⌥ T'],
    ['Shortcuts', '?'],
  ];

  /** Shown inside the effects panel section of the sheet. */
  var EQ_SHORTCUTS = [
    ['Move band frequency', '← →'],
    ['…by an octave', '⇧ ← →'],
    ['Band gain', '↑ ↓'],
    ['Band Q', '[ ]'],
    ['Select previous / next band', 'PgUp PgDn'],
    ['Filter type menu', '↵'],
    ['Remove band', '⌫'],
    ['Add band an octave up', '+'],
  ];

  function openShortcuts() {
    var body = shortcutsDlg.querySelector('.shortcuts');
    if (!body.childElementCount) {
      var addRows = function (list) {
        list.forEach(function (pair) {
          var row = MP.util.el('div', 'shortcuts__row');
          row.appendChild(MP.util.el('span', null, pair[0]));
          row.appendChild(MP.util.el('kbd', null, pair[1]));
          body.appendChild(row);
        });
      };
      addRows(SHORTCUTS);
      var heading = MP.util.el('div', 'settings-group__label', 'Equaliser curve');
      heading.style.gridColumn = '1 / -1';
      heading.style.marginTop = 'var(--space-4)';
      body.appendChild(heading);
      addRows(EQ_SHORTCUTS);
    }
    shortcutsDlg.showModal();
  }

  // -- init ----------------------------------------------------------------

  function anyOpen() {
    return !!document.querySelector('dialog[open]');
  }

  function init() {
    addDlg = document.getElementById('add-dialog');
    addForm = document.getElementById('add-form');
    addField = document.getElementById('magnet-input');
    addHint = document.getElementById('add-hint');
    addSubmit = document.getElementById('add-submit');
    confirmDlg = document.getElementById('confirm-dialog');
    shortcutsDlg = document.getElementById('shortcuts-dialog');
    promptDlg = document.getElementById('prompt-dialog');

    addForm.addEventListener('submit', submitAdd);
    addField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addForm.requestSubmit();
      }
    });

    document.querySelectorAll('dialog [data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.closest('dialog').close();
      });
    });

    initSettings();
  }

  window.MP.dialogs = {
    init: init,
    openAddMagnet: openAddMagnet,
    openSettings: openSettings,
    openShortcuts: openShortcuts,
    confirm: confirm,
    prompt: prompt,
    anyOpen: anyOpen,
  };
})();
