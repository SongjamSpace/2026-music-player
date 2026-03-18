(function () {
  'use strict';

  function showFatal(msg) {
    const el = document.getElementById('fatal-error');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
    console.error('[Player]', msg);
  }

  if (!window.playerAPI) {
    document.body.innerHTML = '<p id="fatal-error" style="padding:1rem;color:#e07070;display:block;">Player API not loaded. Run the app with Electron (npm start).</p>';
    throw new Error('playerAPI not available');
  }

  const playerAPI = window.playerAPI;
  let magnetInput, addTorrentBtn, addStatusEl, torrentListEl, filesHint, fileListEl, nowPlayingEl, audioPlayer, videoPlayer;

  function setAddStatus(text, isError) {
    if (addStatusEl) {
      addStatusEl.textContent = text || '';
      addStatusEl.classList.toggle('error', !!isError);
      addStatusEl.style.display = text ? 'block' : 'none';
    }
    if (nowPlayingEl && text) nowPlayingEl.textContent = text;
  }

  function extractMagnet(str) {
    const s = (str || '').trim();
    if (!s) return null;
    const magnetIndex = s.indexOf('magnet:');
    if (magnetIndex === -1) return null;
    const fromMagnet = s.slice(magnetIndex);
    const newline = fromMagnet.indexOf('\n');
    const space = fromMagnet.indexOf(' ');
    const end = newline >= 0 ? (space >= 0 ? Math.min(newline, space) : newline) : (space >= 0 ? space : fromMagnet.length);
    return fromMagnet.slice(0, end).trim();
  }

  let torrents = new Map();
  let selectedTorrentId = null;
  let streamBaseURL = null;
  let currentTorrentId = null;
  let currentFileIndex = null;

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '—';
    return formatBytes(bytesPerSec) + '/s';
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function isVideoFile(file) {
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogv'];
    const videoTypes = ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo'];
    return videoExtensions.some(function (ext) { return name.endsWith(ext); }) || videoTypes.some(function (t) { return type.includes(t); });
  }

  function renderTorrents() {
    if (!torrentListEl) return;
    torrentListEl.innerHTML = '';
    torrents.forEach(function (t, id) {
      const li = document.createElement('li');
      li.dataset.torrentId = id;
      li.classList.toggle('selected', id === selectedTorrentId);
      const progress = (t.progress != null ? t.progress : 0) * 100;
      li.innerHTML = '<span class="name" title="' + escapeHtml(t.name || id) + '">' + escapeHtml(t.name || id) + '</span>' +
        '<span class="progress-wrap"><span class="progress-bar" style="width:' + progress + '%"></span></span>' +
        '<span class="status">' + (t.done ? 'Done' : (t.numPeers != null && t.numPeers > 0 ? formatSpeed(t.downloadSpeed) : 'Connecting…')) + '</span>';
      li.addEventListener('click', function () { selectTorrent(id); });
      torrentListEl.appendChild(li);
    });
  }

  function selectTorrent(id) {
    selectedTorrentId = id;
    renderTorrents();
    renderFiles(id);
    var openBtn = document.getElementById('open-torrent-folder-btn');
    if (openBtn) openBtn.style.display = id ? 'inline-block' : 'none';
  }

  function getFileProgress(torrentId, fileIndex) {
    const t = torrents.get(torrentId);
    if (!t) return 0;
    const arr = t.fileProgress;
    if (arr && arr[fileIndex] != null && arr[fileIndex].progress != null) return Math.min(1, arr[fileIndex].progress);
    if (t.files && t.files[fileIndex] && t.files[fileIndex].progress != null) return Math.min(1, t.files[fileIndex].progress);
    return 0;
  }

  function renderFiles(torrentId) {
    const t = torrents.get(torrentId);
    if (!fileListEl) return;
    fileListEl.innerHTML = '';
    if (filesHint) filesHint.style.display = 'none';
    if (!t || !t.files || t.files.length === 0) {
      if (filesHint) {
        filesHint.style.display = 'block';
        filesHint.textContent = selectedTorrentId ? 'No files.' : 'Select a torrent to see its files.';
      }
      return;
    }
    t.files.forEach(function (file, index) {
      const li = document.createElement('li');
      li.dataset.torrentId = torrentId;
      li.dataset.fileIndex = String(index);
      const prog = getFileProgress(torrentId, index);
      const pct = Math.round(prog * 100);
      const progHtml = '<span class="file-progress-wrap"><span class="file-progress-bar" style="width:' + pct + '%"></span></span><span class="file-progress-pct">' + (pct === 100 ? '✓' : pct + '%') + '</span>';
      li.innerHTML = '<span class="track-num">' + (index + 1) + '</span><span class="name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</span><span class="size">' + formatBytes(file.length) + '</span>' + progHtml;
      li.addEventListener('click', function () { playFile(torrentId, index); });
      fileListEl.appendChild(li);
    });
  }

  function updateTrackPosition() {
    const posEl = document.getElementById('track-position');
    if (!posEl) return;
    if (currentTorrentId == null || currentFileIndex == null) {
      posEl.textContent = '';
      return;
    }
    const t = torrents.get(currentTorrentId);
    const total = t && t.files ? t.files.length : 0;
    posEl.textContent = total ? 'Track ' + (currentFileIndex + 1) + ' of ' + total : '';
  }

  function playFile(torrentId, fileIndex) {
    const t = torrents.get(torrentId);
    if (!t || !t.files || !t.files[fileIndex]) return;
    const file = t.files[fileIndex];
    const url = file.streamURL;
    if (!url) return;
    currentTorrentId = torrentId;
    currentFileIndex = fileIndex;
    var nextIdx = fileIndex + 1 < t.files.length ? fileIndex + 1 : fileIndex;
    if (playerAPI.setPlaybackPriority) playerAPI.setPlaybackPriority(torrentId, fileIndex, nextIdx);
    if (fileListEl) fileListEl.querySelectorAll('li').forEach(function (el) { el.classList.remove('playing'); });
    const li = fileListEl ? fileListEl.querySelector('[data-torrent-id="' + torrentId + '"][data-file-index="' + fileIndex + '"]') : null;
    if (li) li.classList.add('playing');
    const isVideo = isVideoFile(file);
    if (isVideo) {
      if (audioPlayer) { audioPlayer.pause(); audioPlayer.removeAttribute('src'); }
      if (videoPlayer) {
        videoPlayer.style.display = 'block';
        videoPlayer.src = url;
        videoPlayer.play().catch(function () {});
      }
      if (nowPlayingEl) nowPlayingEl.textContent = 'Playing: ' + file.name;
    } else {
      if (videoPlayer) { videoPlayer.pause(); videoPlayer.removeAttribute('src'); videoPlayer.style.display = 'none'; }
      if (audioPlayer) {
        audioPlayer.src = url;
        audioPlayer.play().catch(function () {});
      }
      if (nowPlayingEl) nowPlayingEl.textContent = 'Playing: ' + file.name;
    }
    updateTrackPosition();
  }

  function goNext() {
    if (currentTorrentId == null || currentFileIndex == null) return;
    const t = torrents.get(currentTorrentId);
    if (!t || !t.files) return;
    if (currentFileIndex + 1 < t.files.length) playFile(currentTorrentId, currentFileIndex + 1);
  }

  function goPrev() {
    if (currentTorrentId == null || currentFileIndex == null) return;
    const t = torrents.get(currentTorrentId);
    if (!t || !t.files) return;
    if (currentFileIndex > 0) {
      playFile(currentTorrentId, currentFileIndex - 1);
    } else if (audioPlayer && audioPlayer.src) {
      audioPlayer.currentTime = 0;
      audioPlayer.play().catch(function () {});
    } else if (videoPlayer && videoPlayer.src) {
      videoPlayer.currentTime = 0;
      videoPlayer.play().catch(function () {});
    }
  }

  function onMediaEnded() {
    goNext();
  }

  function updateTorrent(data) {
    const existing = torrents.get(data.id);
    const files = (existing && existing.files) ? existing.files : (data.files || []);
    const fileProgress = data.fileProgress != null ? data.fileProgress : (existing && existing.fileProgress);
    torrents.set(data.id, {
      id: data.id,
      name: data.name != null ? data.name : (existing && existing.name),
      magnetURI: data.magnetURI != null ? data.magnetURI : (existing && existing.magnetURI),
      files: files,
      progress: data.progress != null ? data.progress : (existing && existing.progress),
      numPeers: data.numPeers != null ? data.numPeers : (existing && existing.numPeers),
      downloadSpeed: data.downloadSpeed != null ? data.downloadSpeed : (existing && existing.downloadSpeed),
      timeRemaining: data.timeRemaining != null ? data.timeRemaining : (existing && existing.timeRemaining),
      done: data.done != null ? data.done : (existing && existing.done),
      fileProgress: fileProgress,
    });
    renderTorrents();
    if (selectedTorrentId === data.id) renderFiles(data.id);
  }

  function onAddClick() {
    setAddStatus('Adding torrent…', false);
    var magnet = extractMagnet(magnetInput ? magnetInput.value : '');
    if (!magnet || magnet.indexOf('magnet:') !== 0) {
      setAddStatus('Paste a magnet link (starts with magnet: and contains xt=urn:btih:).', true);
      return;
    }
    if (addTorrentBtn) addTorrentBtn.disabled = true;
    playerAPI.addTorrent(magnet).then(function (result) {
      if (magnetInput) magnetInput.value = '';
      if (result && result.pending) {
        setAddStatus('Fetching metadata from peers… The torrent will appear in the list below when ready.');
      } else {
        setAddStatus('Torrent added. Select it below, then choose a file to play.');
      }
    }).catch(function (err) {
      setAddStatus('Error: ' + (err && err.message ? err.message : String(err)), true);
    }).finally(function () {
      if (addTorrentBtn) addTorrentBtn.disabled = false;
    });
  }

  function run() {
    magnetInput = document.getElementById('magnet-input');
    addTorrentBtn = document.getElementById('add-torrent-btn');
    addStatusEl = document.getElementById('add-status');
    torrentListEl = document.getElementById('torrent-list');
    filesHint = document.getElementById('files-hint');
    fileListEl = document.getElementById('file-list');
    nowPlayingEl = document.getElementById('now-playing');
    audioPlayer = document.getElementById('audio-player');
    videoPlayer = document.getElementById('video-player');

    if (!addTorrentBtn) {
      showFatal('Add torrent button not found. Check that the page loaded correctly.');
      return;
    }
    if (!addStatusEl) {
      addStatusEl = document.createElement('div');
      addStatusEl.id = 'add-status';
      addStatusEl.className = 'add-status';
      if (addTorrentBtn.parentNode) addTorrentBtn.parentNode.appendChild(addStatusEl);
    }

    addTorrentBtn.addEventListener('click', onAddClick);

    var btnPrev = document.getElementById('btn-prev');
    var btnNext = document.getElementById('btn-next');
    if (btnPrev) btnPrev.addEventListener('click', goPrev);
    if (btnNext) btnNext.addEventListener('click', goNext);
    if (audioPlayer) audioPlayer.addEventListener('ended', onMediaEnded);
    if (videoPlayer) videoPlayer.addEventListener('ended', onMediaEnded);

    var openTorrentFolderBtn = document.getElementById('open-torrent-folder-btn');
    if (openTorrentFolderBtn) openTorrentFolderBtn.addEventListener('click', function () {
      if (!selectedTorrentId || !playerAPI.openTorrentFolder) return;
      playerAPI.openTorrentFolder(selectedTorrentId).then(function (r) {
        if (r && r.error) setAddStatus('Could not open folder: ' + r.error, true);
      });
    });
    var openDownloadFolderBtn = document.getElementById('open-download-folder-btn');
    if (openDownloadFolderBtn) openDownloadFolderBtn.addEventListener('click', function () {
      if (!playerAPI.openDownloadFolder) return;
      playerAPI.openDownloadFolder().then(function (r) {
        if (r && r.error) setAddStatus('Could not open folder: ' + r.error, true);
      });
    });

    playerAPI.onTorrentReady(function (data) { updateTorrent(data); });
    playerAPI.onTorrentProgress(function (data) { updateTorrent(data); });
    playerAPI.onTorrentError(function (data) {
      setAddStatus('Torrent error: ' + (data && data.message ? data.message : 'Unknown error'), true);
    });
    playerAPI.onRestoreMagnets(function (magnets) {
      if (!Array.isArray(magnets) || magnets.length === 0) return;
      setAddStatus('Restoring saved torrents…', false);
      magnets.forEach(function (m) { playerAPI.addTorrent(m).catch(function () {}); });
    });

    playerAPI.getStreamBaseURL().then(function () {});
    playerAPI.getTorrents().then(function (list) {
      if (list && list.length) list.forEach(function (t) { updateTorrent(t); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  window.addEventListener('error', function (e) {
    showFatal('Error: ' + (e.message || e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    showFatal('Unhandled error: ' + (e.reason && (e.reason.message || e.reason) || e));
  });
})();
