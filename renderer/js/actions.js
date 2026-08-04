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

  /** With a fileIndex, reveals and highlights that track; without, the album folder. */
  function openTorrentFolder(id, fileIndex) {
    return window.playerAPI.openTorrentFolder(id, fileIndex).then(function (r) {
      if (r && r.error) MP.toast.error('Could not open folder: ' + r.error);
    });
  }

  /**
   * Re-fetch one damaged track from the swarm.
   *
   * Only the torrent's piece hashes can tell good bytes from bad, so this marks the
   * track unverified and puts the torrent back up — WebTorrent re-hashes the album
   * and re-downloads only what fails. That hashing is real work against the drive,
   * so the toast says so rather than looking like nothing happened.
   */
  function repairTrack(id, fileIndex) {
    return window.playerAPI.repairTrack(id, fileIndex).then(function (r) {
      if (r && r.error) {
        MP.toast.error(r.error);
        return;
      }
      MP.toast.show(
        'Checking this album against the torrent and re-downloading the damaged part. ' +
          'Verifying takes a while on an external drive.'
      );
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

  /**
   * Bring an archived album back into the swarm so it can upload.
   *
   * Completed albums stop seeding after a grace window, so they cost nothing while
   * sitting in the library. This is the way back in when you want to give back to a
   * specific swarm.
   */
  function seedAlbum(id) {
    var t = MP.store.getTorrent(id);
    var name = (t && t.name) || 'this album';
    return window.playerAPI.seedAlbum(id).then(function (res) {
      if (res && res.success) MP.toast.show('Seeding “' + name + '”.');
      else MP.toast.error('Couldn’t start seeding “' + name + '”.');
    });
  }

  /** Start a download that is queued behind the live-torrent cap. */
  function resumeAlbum(id) {
    var t = MP.store.getTorrent(id);
    var name = (t && t.name) || 'this album';
    return window.playerAPI.resumeAlbum(id).then(function (res) {
      if (res && res.success) MP.toast.show('Resumed “' + name + '”.');
      else MP.toast.error('Couldn’t resume “' + name + '”.');
    });
  }

  window.MP.actions = {
    addMagnet: addMagnet,
    openTorrentFolder: openTorrentFolder,
    repairTrack: repairTrack,
    openDownloadFolder: openDownloadFolder,
    removeTorrent: removeTorrent,
    seedAlbum: seedAlbum,
    resumeAlbum: resumeAlbum,
  };
})();
