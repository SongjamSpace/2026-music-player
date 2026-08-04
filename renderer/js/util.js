(function () {
  'use strict';

  /**
   * Torrent payloads are classified purely by extension.
   *
   * WebTorrent does not populate `file.type` — every file arrives as
   * `application/octet-stream`, including .flac and .jpg — so any MIME-based
   * test is dead code. The extension is the only signal available.
   */

  // Every extension that IS media, whether or not this build can decode it.
  // Anything media stays visible (labelled "Unsupported" if undecodable);
  // anything not on these lists is a sidecar and gets hidden.
  var AUDIO_EXTENSIONS = [
    '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.wave', '.ogg', '.oga',
    '.opus', '.weba', '.aif', '.aiff', '.aifc', '.wma', '.ape', '.alac',
    '.dsf', '.dff', '.mpc', '.wv', '.tta', '.shn', '.ac3', '.dts', '.amr', '.au',
  ];

  var VIDEO_EXTENSIONS = [
    '.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.wmv', '.flv',
    '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts',
  ];

  var IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];

  // Extension → the MIME string to hand to canPlayType(). Only formats Chromium
  // has any chance with are listed; a media extension missing from here is
  // simply reported as undecodable.
  var PROBE_MIME = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.m4b': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.wave': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg; codecs=opus',
    '.weba': 'audio/webm',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
  };

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    // Clamp low as well as high: a value between 0 and 1 — which a trickling
    // download speed really does produce — gives a negative exponent, and
    // sizes[-1] renders as "819.2 undefined".
    var i = Math.max(0, Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '—';
    return formatBytes(bytesPerSec) + '/s';
  }

  /**
   * Judge the observed traffic path against what the user said to expect.
   *
   * Pure and lives here rather than inside the settings dialog so the whole
   * table can be exercised without arranging the world to match — half these
   * states need a VPN to drop, which is not something a check should require.
   *
   * `vpnPreferred` is the split-tunnel mode and reads oddly on purpose: a VPN
   * that is up while torrents go direct is the goal, not a problem. The failure
   * it watches for is torrents being pulled back into the tunnel, because that
   * is when inbound peers disappear.
   *
   * @param {string} expected  'auto' | 'direct' | 'vpn' | 'vpn-preferred'
   * @param {boolean} tunnel   traffic is currently egressing a tunnel
   * @param {boolean} vpnUp    a tunnel interface exists, used or not
   */
  function pathVerdict(expected, tunnel, vpnUp) {
    if (expected === 'vpn-preferred') {
      if (tunnel) {
        return {
          cls: 'is-warn',
          desc: 'Torrents are going through the VPN, so no peer can connect in. Your split tunnel is not live.',
        };
      }
      return vpnUp
        ? { cls: 'is-good', desc: 'Split tunnel working — the VPN is up for other traffic while torrents go direct.' }
        : { cls: 'is-good', desc: 'VPN is down. Downloads continue directly; other traffic is no longer tunnelled.' };
    }
    if (expected === 'direct' && tunnel) {
      return {
        cls: 'is-bad',
        desc: 'You expect a direct path, but macOS is routing everything through the tunnel. This app cannot override that — see "Split tunnelling" in the README.',
      };
    }
    if (expected === 'vpn' && !tunnel) {
      return {
        cls: 'is-bad',
        desc: 'You expect the VPN, but traffic is going out in the clear. The tunnel may have dropped.',
      };
    }
    return { cls: 'is-good', desc: null };
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

  // Enough to cover what turns up in scraped release titles. Anything not listed
  // is left exactly as it was found, which is the safe direction: a name is only
  // ever displayed, so an undecoded entity is ugly whereas a wrong guess is a lie.
  var NAMED_ENTITIES = {
    quot: '"', apos: "'", lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
    ndash: '–', mdash: '—', hellip: '…', nbsp: ' ',
    middot: '·', bull: '•', deg: '°', trade: '™',
    copy: '©', reg: '®', eacute: 'é', amp: '&', lt: '<', gt: '>',
  };

  /**
   * Turn HTML entities in a *display* string back into characters.
   *
   * Magnet `dn=` values are routinely scraped straight out of a web page, so an
   * apostrophe arrives as `&rsquo;` and shows up literally in the UI — every
   * title in this app is set through `textContent`, which is what stops markup in
   * a torrent name being markup, and also what stops an entity being decoded.
   *
   * Deliberately a table and a regex rather than round-tripping through
   * `innerHTML` or a detached textarea. Parsing attacker-supplied text as HTML to
   * read it back out is how injection bugs happen, and a torrent name is
   * attacker-supplied. This cannot execute anything.
   *
   * One pass, left to right, so `&amp;rsquo;` decodes to the literal `&rsquo;`
   * rather than to an apostrophe: the `&amp;` is consumed first and the scan
   * resumes after it.
   *
   * Never use on a filesystem path — the bytes on disk are whatever they are.
   */
  function decodeEntities(text) {
    if (text == null) return text;
    var s = String(text);
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, function (whole, body) {
      if (body.charAt(0) !== '#') {
        var named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
      }
      var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      var cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Lone surrogates and C0 controls are not worth reconstructing from a title.
      if (!isFinite(cp) || cp < 32 || cp > 0x10ffff) return whole;
      if (cp >= 0xd800 && cp <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch (_) {
        return whole;
      }
    });
  }

  /**
   * The `dn=` display name, if the magnet carries one. Gives a pending row a
   * real title instead of a placeholder while metadata is still being fetched.
   */
  function parseDisplayName(magnetUri) {
    var m = /[?&]dn=([^&]+)/.exec(magnetUri || '');
    if (!m) return null;
    try {
      return decodeEntities(decodeURIComponent(m[1].replace(/\+/g, ' ')).trim()) || null;
    } catch (_) {
      return null;
    }
  }

  function extOf(file) {
    var name = ((file && file.name) || '').toLowerCase();
    var dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot);
  }

  function hasExt(file, list) {
    return list.indexOf(extOf(file)) !== -1;
  }

  function isVideoFile(file) {
    return hasExt(file, VIDEO_EXTENSIONS);
  }

  function isAudioFile(file) {
    return hasExt(file, AUDIO_EXTENSIONS);
  }

  /** Audio or video, regardless of whether we can decode it. */
  function isMediaFile(file) {
    return isAudioFile(file) || isVideoFile(file);
  }

  // canPlayType needs a media element; one is enough, and the answers are
  // per-format constants, so cache them.
  var probeEl = null;
  var decodeCache = {};

  /** Asks the engine rather than trusting a hand-maintained whitelist. */
  function canDecode(file) {
    var ext = extOf(file);
    if (decodeCache[ext] != null) return decodeCache[ext];
    var mime = PROBE_MIME[ext];
    if (!mime) {
      decodeCache[ext] = false;
      return false;
    }
    if (!probeEl) probeEl = document.createElement('video');
    decodeCache[ext] = probeEl.canPlayType(mime) !== '';
    return decodeCache[ext];
  }

  /**
   * 'audio' | 'video' | 'image' | 'other'.
   * 'other' is the cue sheets, rip logs, .accurip/.toc/.m3u checksums and
   * readmes that ship with most CD rips — noise in a track list.
   */
  function fileKind(file) {
    if (isAudioFile(file)) return 'audio';
    if (isVideoFile(file)) return 'video';
    if (isImageFile(file)) return 'image';
    return 'other';
  }

  function isImageFile(file) {
    return hasExt(file, IMAGE_EXTENSIONS);
  }

  function isPlayableAudio(file) {
    return isAudioFile(file) && canDecode(file);
  }

  /** Media this build can actually decode — safe to put in a play queue. */
  function isPlayable(file) {
    return (isAudioFile(file) || isVideoFile(file)) && canDecode(file);
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
    pathVerdict: pathVerdict,
    formatDuration: formatDuration,
    formatETA: formatETA,
    extractMagnet: extractMagnet,
    parseInfoHash: parseInfoHash,
    parseDisplayName: parseDisplayName,
    decodeEntities: decodeEntities,
    isVideoFile: isVideoFile,
    isAudioFile: isAudioFile,
    isImageFile: isImageFile,
    isMediaFile: isMediaFile,
    isPlayableAudio: isPlayableAudio,
    isPlayable: isPlayable,
    canDecode: canDecode,
    fileKind: fileKind,
    extOf: extOf,
    hueFromId: hueFromId,
    tpl: tpl,
    el: el,
    debounce: debounce,
    clamp: clamp,
  };
})();
