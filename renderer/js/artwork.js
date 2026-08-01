(function () {
  'use strict';

  /**
   * Cover art from an image file inside the torrent.
   *
   * The image is served by the same per-torrent HTTP server as the audio, so it
   * needs no new plumbing — but it does need two things: `img-src` has to allow
   * the loopback origin (see the CSP in index.html), and the file has to be
   * fully downloaded before we point an <img> at it, because a partial stream
   * just hangs and never decodes.
   */

  // Names that conventionally mean "this is the album cover", best first.
  var PREFERRED = ['cover', 'folder', 'front', 'album', 'artwork', 'art'];

  var resolved = new Map(); // torrentId -> url | null  (image file inside the torrent)
  var embedded = new Map(); // torrentId -> url | null  (art read out of the audio tags)
  var inFlight = new Set();
  var watchers = new Map(); // torrentId -> [{tile, index}] to repaint on arrival

  function pickCover(torrent) {
    var files = torrent && torrent.files;
    if (!files || !files.length) return null;

    var images = [];
    files.forEach(function (f, i) {
      if (MP.util.isImageFile(f)) images.push({ file: f, index: i });
    });
    if (!images.length) return null;

    for (var p = 0; p < PREFERRED.length; p++) {
      for (var i = 0; i < images.length; i++) {
        var base = images[i].file.name.toLowerCase();
        if (base.indexOf(PREFERRED[p]) !== -1) return images[i];
      }
    }
    // No conventional name — the largest image is almost always the cover
    // rather than a scan or a logo.
    return images.reduce(function (best, cur) {
      return cur.file.length > best.file.length ? cur : best;
    });
  }

  /** Index of the cover file, so playback can keep it selected for download. */
  function coverIndex(torrent) {
    var hit = pickCover(torrent);
    return hit ? hit.index : null;
  }

  function coverFileUrl(torrent) {
    if (resolved.has(torrent.id)) return resolved.get(torrent.id);

    var hit = pickCover(torrent);
    if (!hit || !hit.file.streamURL) return null;

    // Wait for the whole file. Covers are a handful of pieces, and this avoids
    // a broken-image flash or a request that never completes.
    if (MP.store.fileProgress(torrent.id, hit.index) < 1) return null;

    resolved.set(torrent.id, hit.file.streamURL);
    return hit.file.streamURL;
  }

  /**
   * Many releases ship no image file and carry the art in the audio tags —
   * that's what Finder shows. Reading tags needs the filesystem, so it happens
   * in the main process; the result is cached and the tiles repaint when it
   * lands.
   */
  function requestEmbedded(torrentId) {
    if (embedded.has(torrentId) || inFlight.has(torrentId)) return;
    inFlight.add(torrentId);
    window.playerAPI
      .getAlbumArt(torrentId)
      .then(function (result) {
        inFlight.delete(torrentId);
        if (result === null) {
          // Parsed a complete file and found nothing — don't ask again.
          embedded.set(torrentId, null);
        } else if (result && result.url) {
          embedded.set(torrentId, result.url);
          repaint(torrentId);
        }
        // `undefined`/no candidates yet: leave unset so a later tick retries.
      })
      .catch(function () {
        inFlight.delete(torrentId);
        embedded.set(torrentId, null);
      });
  }

  function repaint(torrentId) {
    var list = watchers.get(torrentId);
    if (!list) return;
    list.forEach(function (entry) {
      // Force a re-evaluation past the idempotency guard.
      entry.tile.dataset.artState = '';
      apply(entry.tile, MP.store.getTorrent(torrentId), entry.index);
    });
  }

  function watch(torrentId, tile, index) {
    if (!watchers.has(torrentId)) watchers.set(torrentId, []);
    var list = watchers.get(torrentId);
    if (!list.some(function (e) { return e.tile === tile; })) {
      list.push({ tile: tile, index: index });
    }
  }

  function coverUrl(torrent) {
    if (!torrent) return null;
    var fromFile = coverFileUrl(torrent);
    if (fromFile) return fromFile;
    if (embedded.has(torrent.id)) return embedded.get(torrent.id);
    requestEmbedded(torrent.id);
    return null;
  }

  function forget(torrentId) {
    resolved.delete(torrentId);
    embedded.delete(torrentId);
    watchers.delete(torrentId);
  }

  /** URL for one specific image file, once it has fully downloaded. */
  function fileUrl(torrent, index) {
    if (!torrent || !torrent.files) return null;
    var file = torrent.files[index];
    if (!file || !file.streamURL || !MP.util.isImageFile(file)) return null;
    if (MP.store.fileProgress(torrent.id, index) < 1) return null;
    return file.streamURL;
  }

  /**
   * Idempotent: safe to call on every repaint. Only touches the DOM when the
   * torrent or the resolved URL actually changes.
   *
   * @param {number} [index] render this specific image instead of the cover
   */
  function apply(tile, torrent, index) {
    if (!tile) return;
    var id = torrent ? torrent.id : '';
    var url = torrent ? (index != null ? fileUrl(torrent, index) : coverUrl(torrent)) : null;
    if (torrent) watch(id, tile, index);
    var stateKey = id + '|' + (index != null ? index : 'cover') + '|' + (url || '');
    if (tile.dataset.artState === stateKey) return;
    tile.dataset.artState = stateKey;

    tile.style.setProperty('--art-hue', torrent ? MP.util.hueFromId(id) : 220);

    var existing = tile.querySelector('.artwork__img');
    if (!url) {
      if (existing) existing.remove();
      tile.classList.remove('has-image');
      return;
    }
    if (existing && existing.src === url) return;
    if (existing) existing.remove();

    var img = document.createElement('img');
    img.className = 'artwork__img';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', function () {
      tile.classList.add('has-image');
    });
    img.addEventListener('error', function () {
      // Corrupt or unreadable — fall back to the generated tile and don't retry.
      // Poison whichever source produced this URL, not both.
      img.remove();
      tile.classList.remove('has-image');
      if (index != null) return;
      if (embedded.get(id) === url) embedded.set(id, null);
      else resolved.set(id, null);
    });
    img.src = url;
    tile.appendChild(img);
  }

  window.MP.artwork = {
    coverIndex: coverIndex,
    coverUrl: coverUrl,
    apply: apply,
    forget: forget,
  };
})();
