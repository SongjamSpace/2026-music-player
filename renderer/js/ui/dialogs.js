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

  function openSettings() {
    var s = MP.store.state.settings;
    settingsDlg.querySelector('#settings-path').textContent = s.downloadPath || '—';
    settingsDlg.querySelector('#settings-version').textContent = s.version ? 'Version ' + s.version : '';
    settingsDlg.querySelector('#settings-count').textContent =
      MP.store.state.torrentOrder.length + ' in library';
    buildThemePicker(settingsDlg.querySelector('#theme-picker'));
    settingsDlg.showModal();
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

    settingsDlg.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { settingsDlg.close(); });
    });
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
