(function () {
  'use strict';

  /** Shared side-effecting operations, so UI components don't each own IPC calls. */

  function addMagnet(raw, opts) {
    opts = opts || {};
    var magnet = MP.util.extractMagnet(raw);
    if (!magnet || magnet.indexOf('magnet:') !== 0) {
      return Promise.reject(new Error('That doesn’t look like a magnet link.'));
    }

    // The infohash in the URI is the id the main process will report, so an
    // optimistic row keyed on it collides correctly with the real torrent-ready
    // rather than producing a duplicate.
    var hash = MP.util.parseInfoHash(magnet);
    if (hash && !MP.store.getTorrent(hash)) {
      MP.store.addPending(hash, MP.util.parseDisplayName(magnet) || opts.label || 'Fetching metadata…');
    }

    return window.playerAPI.addTorrent(magnet).then(function (result) {
      if (result && result.duplicate) {
        MP.toast.show('That torrent is already in your library.');
      } else if (!opts.silent) {
        MP.toast.show('Fetching metadata from peers…');
      }
      return result;
    }).catch(function (err) {
      if (hash) MP.store.removeTorrent(hash);
      throw err;
    });
  }

  function openTorrentFolder(id) {
    return window.playerAPI.openTorrentFolder(id).then(function (r) {
      if (r && r.error) MP.toast.error('Could not open folder: ' + r.error);
    });
  }

  function openDownloadFolder() {
    return window.playerAPI.openDownloadFolder().then(function (r) {
      if (r && r.error) MP.toast.error('Could not open folder: ' + r.error);
    });
  }

  function removeTorrent(id, deleteFiles) {
    var t = MP.store.getTorrent(id);
    if (!t) return Promise.resolve();
    var name = t.name || id;

    return MP.dialogs
      .confirm({
        title: deleteFiles ? 'Delete downloaded files?' : 'Remove from library?',
        body: deleteFiles
          ? 'This removes “' + name + '” and permanently deletes everything it downloaded. This can’t be undone.'
          : 'This removes “' + name + '” from your library. Downloaded files are kept on disk.',
        confirmLabel: deleteFiles ? 'Delete Files' : 'Remove',
        danger: true,
      })
      .then(function (ok) {
        if (!ok) return;
        // Stop playback first if it's coming from this torrent.
        if (MP.store.state.playback.torrentId === id) {
          var media = MP.player.activeMedia();
          if (media) {
            media.pause();
            media.removeAttribute('src');
            media.load();
          }
          MP.store.setPlayback({ torrentId: null, fileIndex: null, isPlaying: false }, 'playback:track');
        }
        return window.playerAPI.removeTorrent(id, !!deleteFiles).then(function () {
          MP.artwork.forget(id);
          MP.store.removeTorrent(id);
          MP.toast.show(deleteFiles ? 'Removed and deleted “' + name + '”.' : 'Removed “' + name + '”.');
        });
      });
  }

  window.MP.actions = {
    addMagnet: addMagnet,
    openTorrentFolder: openTorrentFolder,
    openDownloadFolder: openDownloadFolder,
    removeTorrent: removeTorrent,
  };
})();
