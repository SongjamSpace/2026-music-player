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
  var embedded = new Map(); // torrentId -> hero url | null  (from the art cache)
  var thumbs = new Map(); // torrentId -> 96px url, for small tiles
  var inFlight = new Set();
  var watchers = new Map(); // torrentId -> [{tile, index}] to repaint on arrival

  /**
   * Retry budget for the 'pending' status.
   *
   * 'pending' means nothing readable has downloaded yet, so it is worth asking again —
   * but not forever. Without a bound, an album that never completes would have its
   * tiles re-asking main on every repaint for the life of the window.
   */
  var MAX_PENDING_ASKS = 12;
  var pendingAsks = new Map(); // torrentId -> count

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
    if (!hit) return null;

    // `localURL` is only ever set for a file already complete on disk, so its
    // presence *is* the completeness check — and it reads the file directly rather
    // than through the torrent's piece store.
    if (hit.file.localURL) {
      resolved.set(torrent.id, hit.file.localURL);
      return hit.file.localURL;
    }

    if (!hit.file.streamURL) return null;
    // Wait for the whole file. Covers are a handful of pieces, and this avoids
    // a broken-image flash or a request that never completes.
    if (MP.store.fileProgress(torrent.id, hit.index) < 1) return null;

    resolved.set(torrent.id, hit.file.streamURL);
    return hit.file.streamURL;
  }

  /**
   * Art from the main process's cache: a real image file in the album folder, or
   * failing that the picture embedded in the audio tags.
   *
   * What comes back is a URL into the local file server, not image data. It used to
   * be a base64 data URL, which meant this Map held a full copy of every cover for
   * the life of the window — on top of the copy in the main process and the decoded
   * bitmap in Chromium. Now these are ~80-character strings and the bytes live on
   * disk, resized.
   */
  function requestEmbedded(torrentId) {
    if (embedded.has(torrentId) || inFlight.has(torrentId)) return;
    inFlight.add(torrentId);
    window.playerAPI
      .getAlbumArt(torrentId)
      .then(function (result) {
        inFlight.delete(torrentId);
        var status = result && result.status;

        // Only 'none' is terminal. 'pending' means nothing readable has downloaded
        // yet, so leaving the key unset is what allows a later tick to retry — the
        // previous version could not tell the two apart and cached "no art" forever
        // for any torrent that was still downloading when its tile first rendered,
        // which was all of them.
        if (status === 'none') {
          embedded.set(torrentId, null);
          pendingAsks.delete(torrentId);
        } else if (status === 'ok' && result.url) {
          embedded.set(torrentId, result.url);
          if (result.thumbUrl) thumbs.set(torrentId, result.thumbUrl);
          pendingAsks.delete(torrentId);
          repaint(torrentId);
        } else {
          // Still pending. Give up after a bounded number of tries so a permanently
          // incomplete album cannot keep asking for the life of the window.
          var asks = (pendingAsks.get(torrentId) || 0) + 1;
          pendingAsks.set(torrentId, asks);
          if (asks >= MAX_PENDING_ASKS) embedded.set(torrentId, null);
        }
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
      apply(entry.tile, MP.store.getTorrent(torrentId), entry.index, { thumb: entry.thumb });
    });
  }

  function watch(torrentId, tile, index, wantThumb) {
    if (!watchers.has(torrentId)) watchers.set(torrentId, []);
    var list = watchers.get(torrentId);
    if (!list.some(function (e) { return e.tile === tile; })) {
      list.push({ tile: tile, index: index, thumb: !!wantThumb });
    }
  }

  /**
   * The cover to show for an album.
   *
   * Prefers the main process's cache, which is a resized JPEG — a 96px thumb decodes
   * to ~36 KB where the album's own cover file is routinely 1-3 MB and decodes to
   * many times that. Chromium holds a decoded bitmap per distinct image URL, so
   * pointing tiles at full-size covers was a real cost even once the bytes stopped
   * being copied through JS.
   *
   * The raw file inside the album is used as an immediate stand-in while the cache is
   * still being built, so a cold library still shows art straight away rather than
   * blank tiles. `repaint()` swaps in the resized version when it lands.
   */
  function coverUrl(torrent, wantThumb) {
    if (!torrent) return null;

    if (embedded.has(torrent.id)) {
      var cached = embedded.get(torrent.id);
      if (cached) {
        // Chromium keeps a decoded bitmap per distinct URL, so a small tile asking for
        // the 512px version costs ~1 MB of bitmap where the 96px one costs ~36 KB.
        var thumb = thumbs.get(torrent.id);
        return wantThumb && thumb ? thumb : cached;
      }
      // null means the cache looked and found nothing; the album's own image file, if
      // it has one, is then the only option.
      return coverFileUrl(torrent);
    }

    requestEmbedded(torrent.id);
    return coverFileUrl(torrent);
  }

  function forget(torrentId) {
    resolved.delete(torrentId);
    embedded.delete(torrentId);
    watchers.delete(torrentId);
    pendingAsks.delete(torrentId);
  }

  /** URL for one specific image file, once it has fully downloaded. */
  function fileUrl(torrent, index) {
    if (!torrent || !torrent.files) return null;
    var file = torrent.files[index];
    if (!file || !MP.util.isImageFile(file)) return null;
    // As in coverFileUrl: localURL implies complete, and reads from disk.
    if (file.localURL) return file.localURL;
    if (!file.streamURL) return null;
    if (MP.store.fileProgress(torrent.id, index) < 1) return null;
    return file.streamURL;
  }

  /**
   * Idempotent: safe to call on every repaint. Only touches the DOM when the
   * torrent or the resolved URL actually changes.
   *
   * @param {number} [index] render this specific image instead of the cover
   */
  /**
   * @param {object=} opts
   * @param {boolean=} opts.thumb  Ask for the 96px variant. Set by callers whose tile
   *   is small — the transport's now-playing art — so it does not pay for a 512px
   *   decode it cannot show.
   */
  function apply(tile, torrent, index, opts) {
    if (!tile) return;
    var wantThumb = !!(opts && opts.thumb);
    var id = torrent ? torrent.id : '';
    var url = torrent
      ? (index != null ? fileUrl(torrent, index) : coverUrl(torrent, wantThumb))
      : null;
    if (torrent) watch(id, tile, index, wantThumb);
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
