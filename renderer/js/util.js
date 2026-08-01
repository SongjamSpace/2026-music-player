(function () {
  'use strict';

  var VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogv'];
  var VIDEO_TYPES = [
    'video/mp4',
    'video/webm',
    'video/x-matroska',
    'video/quicktime',
    'video/x-msvideo',
  ];

  // Containers/codecs Chromium can actually decode. Everything else gets dimmed
  // and labelled rather than left to fail with MEDIA_ERR_SRC_NOT_SUPPORTED after
  // the user has already clicked it.
  var AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.weba'];

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '—';
    return formatBytes(bytesPerSec) + '/s';
  }

  /** Seconds → m:ss / h:mm:ss. Returns '—:—' for unknown/Infinity. */
  function formatDuration(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return '—:—';
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /** Milliseconds remaining → coarse human phrase. */
  function formatETA(ms) {
    if (ms == null || !isFinite(ms) || ms <= 0) return null;
    var mins = Math.round(ms / 60000);
    if (mins < 1) return 'under a minute left';
    if (mins < 60) return mins + ' min left';
    var hours = Math.round(mins / 60);
    return hours + (hours === 1 ? ' hour left' : ' hours left');
  }

  function extractMagnet(str) {
    var s = (str || '').trim();
    if (!s) return null;
    var magnetIndex = s.indexOf('magnet:');
    if (magnetIndex === -1) return null;
    var fromMagnet = s.slice(magnetIndex);
    var newline = fromMagnet.search(/[\r\n]/);
    var space = fromMagnet.indexOf(' ');
    var end;
    if (newline >= 0) end = space >= 0 ? Math.min(newline, space) : newline;
    else end = space >= 0 ? space : fromMagnet.length;
    return fromMagnet.slice(0, end).trim();
  }

  /**
   * The lowercased 40-hex infohash IS the torrent id the main process reports,
   * which is what lets an optimistic row collide correctly with the eventual
   * torrent-ready. Base32 (32-char) hashes can't be mapped without decoding,
   * so callers skip the optimistic row for those.
   */
  function parseInfoHash(magnetUri) {
    var m = /xt=urn:btih:([a-fA-F0-9]{40})/.exec(magnetUri || '');
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * The `dn=` display name, if the magnet carries one. Gives a pending row a
   * real title instead of a placeholder while metadata is still being fetched.
   */
  function parseDisplayName(magnetUri) {
    var m = /[?&]dn=([^&]+)/.exec(magnetUri || '');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null;
    } catch (_) {
      return null;
    }
  }

  function isVideoFile(file) {
    var name = ((file && file.name) || '').toLowerCase();
    var type = ((file && file.type) || '').toLowerCase();
    return (
      VIDEO_EXTENSIONS.some(function (ext) { return name.endsWith(ext); }) ||
      VIDEO_TYPES.some(function (t) { return type.indexOf(t) !== -1; })
    );
  }

  var IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];

  function isImageFile(file) {
    var name = ((file && file.name) || '').toLowerCase();
    var type = ((file && file.type) || '').toLowerCase();
    return (
      IMAGE_EXTENSIONS.some(function (ext) { return name.endsWith(ext); }) ||
      type.indexOf('image/') === 0
    );
  }

  function isPlayableAudio(file) {
    var name = ((file && file.name) || '').toLowerCase();
    return AUDIO_EXTENSIONS.some(function (ext) { return name.endsWith(ext); });
  }

  function isPlayable(file) {
    return isPlayableAudio(file) || isVideoFile(file);
  }

  /** Stable 0-359 hue from an infohash, so a torrent's artwork tile never changes. */
  function hueFromId(id) {
    var s = String(id || '');
    var h = 0;
    for (var i = 0; i < Math.min(s.length, 12); i++) {
      h = (h * 31 + s.charCodeAt(i)) % 360;
    }
    return h;
  }

  /** Clone a <template> by selector and return its first element child. */
  function tpl(selector) {
    var t = document.querySelector(selector);
    if (!t) throw new Error('Missing template: ' + selector);
    return t.content.firstElementChild.cloneNode(true);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  window.MP.util = {
    formatBytes: formatBytes,
    formatSpeed: formatSpeed,
    formatDuration: formatDuration,
    formatETA: formatETA,
    extractMagnet: extractMagnet,
    parseInfoHash: parseInfoHash,
    parseDisplayName: parseDisplayName,
    isVideoFile: isVideoFile,
    isImageFile: isImageFile,
    isPlayableAudio: isPlayableAudio,
    isPlayable: isPlayable,
    hueFromId: hueFromId,
    tpl: tpl,
    el: el,
    debounce: debounce,
    clamp: clamp,
  };
})();
