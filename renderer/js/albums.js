(function () {
  'use strict';

  /**
   * Split a torrent into albums.
   *
   * A discography torrent is one library entry holding twenty separate records
   * — Aphex Twin's is 221 files across 18 albums — and as a flat list it is
   * unusable. The fix needs no tags and no network: the torrent's own file
   * paths already carry the structure.
   *
   *   Richard D. James as Aphex Twin (Albums 1992 - 2019) [FLAC]/2016 - Cheetah (EP)/05. CIRKLON3.flac
   *   └─ segment 0, the torrent root ────────────────────────┘ └─ segment 1 ─┘
   *
   * Segment 1 is the album. That is available the instant metadata arrives,
   * before a single byte is downloaded, which is exactly when the list is
   * least navigable.
   *
   * Reading ID3/Vorbis tags would be worse here, not better: those headers sit
   * at the head of each file, and on a torrent this size the head pieces mostly
   * have not been fetched yet — so tags would be blank for most of the list
   * precisely when the grouping is needed.
   */

  /**
   * A path segment that is *only* a disc marker names a disc, not a record.
   *
   * This distinction is the whole game. TRON Legacy is `CD1` and `CD2` — one
   * soundtrack in two parts, and splitting it into two albums would be wrong.
   * Vice City's `Disc1 - V-Rock` carries a real name and is its own thing.
   * `Vol` is deliberately absent: Kill Bill's `Vol.1` and `Vol.2` are two
   * different albums, not two discs of one.
   */
  var DISC_ONLY = /^(cd|disc|disk|d)\s*[-_.]?\s*\d+$/i;

  var ROOT_KEY = '\0root';

  function tidy(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * The running order a filename claims, as an array of numbers to compare.
   *
   * Torrent file order is whatever the packager's filesystem happened to hand
   * back, which is often alphabetical-by-title or plain arbitrary: Animal
   * Collective's *Isn't It Now?* arrives 03, 07, 08, 05, 01… and the filenames
   * are the only statement of intent anywhere in the torrent. Tags would be
   * authoritative but they sit in the head of each file, unread until those
   * pieces are downloaded — the same reason grouping uses paths.
   *
   * Recognised, in order of specificity:
   *
   *   `1-05 Title`   → [1, 5]   disc-track, common on multi-disc rips
   *   `A2 Title`     → [1, 2]   vinyl side and position
   *   `05. Title`    → [0, 5]   the ordinary case
   *
   * Deliberately capped at three digits. A four-digit lead is a year — plenty of
   * live sets and bootlegs are named `1995 Brixton.flac` — and while sorting by
   * year would often be right, it is a different claim from a track number, so
   * those files fall through to file order instead of being guessed at.
   *
   * @returns {number[]|null} null when the name makes no claim.
   */
  function trackOrderKey(fileName) {
    var name = String(fileName || '').replace(/\.[^.]+$/, '');
    var m;

    // `1-05`, `1_05`, `1.05` — a disc number joined to a track number. Requires two
    // digits on the track to avoid eating `2-1` from a title like "Blade 2-1".
    m = /^\s*(\d{1,2})\s*[-_.]\s*(\d{2})(?!\d)/.exec(name);
    if (m) return [Number(m[1]), Number(m[2])];

    // Vinyl sides: `A1`, `B2`, sometimes `A-1`. Letter must be followed by a digit
    // and then a separator, so `A1 Records Presents` does not qualify by accident.
    m = /^\s*([A-H])\s*[-_. ]?\s*(\d{1,2})\s*(?:[-–—._)\]]|\s)/i.exec(name);
    if (m) return [m[1].toUpperCase().charCodeAt(0) - 64, Number(m[2])];

    // The ordinary case. A separator or whitespace must follow, so a title that
    // simply opens with a number — `1984 Overture` — is not mistaken for track 1984,
    // and `99 Luftballons` is not read as track 99 unless it really leads.
    m = /^\s*\[?\s*(\d{1,3})\s*(?:[-–—._)\]]\s*|\s+)/.exec(name);
    if (m) return [0, Number(m[1])];

    // `Gang Gang Dance - 08 - Retina Riddim` — the number is a field of its own,
    // after the artist. Common enough that ignoring it left a whole discography in
    // arbitrary order while every filename said otherwise.
    //
    // The requirement that the field be *nothing but* digits is what makes this safe:
    // `Miles Davis - Take 5` and `Blade Runner - 2049` both have a number in a field,
    // and neither qualifies. The first field is skipped because a leading numeric
    // field is the case above, already handled with tighter rules.
    var fields = name.split(/\s+[-–—]\s+/);
    for (var i = 1; i < fields.length; i++) {
      if (/^\d{1,3}$/.test(fields[i].trim())) return [0, Number(fields[i])];
    }

    return null;
  }

  /**
   * The disc a file sits on, from a `CD2`-style folder anywhere below the album.
   *
   * Grouping already treats such a folder as part of one album (see DISC_ONLY), so
   * without this the second disc's `01` would interleave with the first disc's.
   */
  function discNumber(filePath) {
    var parts = String(filePath || '').split('/');
    for (var i = 2; i < parts.length - 1; i++) {
      if (DISC_ONLY.test(tidy(parts[i]))) {
        var n = /(\d+)/.exec(parts[i]);
        if (n) return Number(n[1]);
      }
    }
    return 0;
  }

  /** Element-wise numeric compare; shorter-but-equal sorts first. */
  function compareKeys(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /**
   * Fraction of a group's files that must claim a track number before the group is
   * reordered at all.
   *
   * The gate is the whole safety story. Reordering on the strength of one numbered
   * file among ten would drag that file to the front of a record whose order was
   * already correct — worse than doing nothing, and hard to attribute. Two thirds
   * leaves room for the odd `Intro.flac` or `Hidden Track.flac` while refusing to
   * act on a release that simply is not numbered.
   */
  var NUMBERED_QUORUM = 2 / 3;

  /**
   * Put a group's file indices into the running order its filenames describe.
   *
   * Stable, and a no-op for the common case where the torrent is already in order —
   * so this only ever moves files that were demonstrably out of place. Files making
   * no claim keep their relative order and follow the numbered ones, which is where
   * bonus material and untitled extras belong.
   */
  function sortGroupIndices(indices, files) {
    var keyed = 0;
    var distinct = {};
    var entries = indices.map(function (index, position) {
      var file = files[index] || {};
      var key = trackOrderKey(file.name || String(file.path || '').split('/').pop());
      if (key) {
        keyed++;
        distinct[key.join('.')] = true;
      }
      return { index: index, position: position, key: key, disc: discNumber(file.path) };
    });

    // Nothing to gain from one number, and nothing to gain from ten copies of the
    // same one either — `Track 01.mp3` repeated per disc folder says nothing on its
    // own, and the disc component is what orders those.
    if (keyed < Math.ceil(indices.length * NUMBERED_QUORUM)) return indices;
    if (Object.keys(distinct).length < 2) return indices;

    entries.sort(function (a, b) {
      if (a.disc !== b.disc) return a.disc - b.disc;
      if (a.key && b.key) {
        var d = compareKeys(a.key, b.key);
        if (d) return d;
      } else if (a.key) {
        return -1;
      } else if (b.key) {
        return 1;
      }
      return a.position - b.position; // stable: file order decides ties
    });

    return entries.map(function (e) { return e.index; });
  }

  /**
   * The album a file belongs to, or null when it sits at the torrent root.
   *
   * Only segment 1 is considered. Anything deeper is a disc, a bonus folder or
   * a scans directory — detail inside the album, not another album.
   */
  function albumSegment(filePath) {
    var parts = String(filePath || '').split('/');
    if (parts.length < 3) return null; // torrent root / file
    var seg = tidy(parts[1]);
    if (!seg) return null;
    // `Torrent/CD1/track.flac` — a disc directly under the root means the whole
    // torrent is one album, so it groups as if the folder weren't there.
    if (DISC_ONLY.test(seg)) return null;
    return seg;
  }

  /**
   * Memo for group() and orderedIndices().
   *
   * Both are pure over the file list, and both were being recomputed — two full
   * passes plus a localeCompare sort — on every play, every shuffle toggle and
   * every torrent switch, via orderedIndices() from player.buildQueue().
   *
   * Keyed on id plus file count: the file list is replaced wholesale when
   * metadata arrives or grows, and the count is what the tracklist already uses
   * to decide its DOM is stale. Torrents with no id skip the memo entirely —
   * that is how scripts/album-grouping-check.js calls in, and keying those on
   * `undefined` would let two fixtures collide.
   */
  var MEMO_MAX = 8;
  var memo = new Map();

  function memoized(torrent, kind, compute) {
    if (!torrent || !torrent.id) return compute();
    var key = torrent.id + ':' + kind + ':' + ((torrent.files && torrent.files.length) || 0);
    if (memo.has(key)) return memo.get(key);
    var value = compute();
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
    memo.set(key, value);
    return value;
  }

  /**
   * @param {object} torrent  Store torrent; needs `files[i].path`.
   * @returns {{grouped: boolean, groups: Array}}
   *   groups: [{ key, name, indices: number[], coverIndex: number|null }]
   *
   * Groups come out in file order and are never sorted. That is load-bearing:
   * keyboard navigation walks file indices numerically and the play queue is
   * built ascending, both independently of this list. Rendering in any other
   * order would leave what you see, what the arrow keys do, and what Play All
   * plays quietly disagreeing.
   */
  function group(torrent) {
    return memoized(torrent, 'group', function () { return computeGroup(torrent); });
  }

  function computeGroup(torrent) {
    var files = (torrent && torrent.files) || [];
    var order = [];
    var byKey = {};

    files.forEach(function (file, index) {
      if (!MP.util.isMediaFile(file)) return;
      var seg = albumSegment(file.path);
      var key = seg === null ? ROOT_KEY : seg;
      if (!byKey[key]) {
        byKey[key] = { key: key, name: seg === null ? 'Other tracks' : seg, indices: [], coverIndex: null };
        order.push(key);
      }
      byKey[key].indices.push(index);
    });

    var groups = order.map(function (k) { return byKey[k]; });

    // Within each record, the running order its filenames describe. Album *grouping*
    // is a statement about folders; this is a statement about files, and they are
    // independent — a correctly grouped discography can still have one record in
    // arbitrary order inside its folder.
    groups.forEach(function (g) {
      g.indices = sortGroupIndices(g.indices, files);
    });

    /*
     * Sorted by name, not left in file order.
     *
     * File order is whatever the person who packaged the torrent happened to
     * do, and it is often nearly-but-not-quite right: the Aphex discography is
     * in chronological order except `2016 - Cheetah` sits at the front, so the
     * list would open on a 2016 EP and then start again at 1992. Because these
     * folders lead with the year, a natural sort restores the chronology — and
     * it is equally right for `01. … 15.` and `Disc1 … Disc7`.
     *
     * `numeric` matters: without it `10.` sorts before `2.`. The root group is
     * pinned last — stray tracks belong after the records, not before them.
     */
    groups.sort(function (a, b) {
      if (a.key === ROOT_KEY) return 1;
      if (b.key === ROOT_KEY) return -1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    // Per-album artwork: the first image sitting in that album's folder.
    // MP.artwork.apply() already accepts a specific file index, so a group
    // header can show its own cover rather than the torrent's.
    if (groups.length > 1) {
      files.forEach(function (file, index) {
        if (!MP.util.isImageFile(file)) return;
        var seg = albumSegment(file.path);
        var key = seg === null ? ROOT_KEY : seg;
        var g = byKey[key];
        if (g && g.coverIndex === null) g.coverIndex = index;
      });
    }

    return { grouped: groups.length > 1, groups: groups };
  }

  /**
   * Playable file indices in the order the track list shows them.
   *
   * Exists because the queue and the list must not disagree. Sorting albums by
   * name means display order is no longer ascending file index, and a queue
   * built the old way would play in a sequence the user cannot see — skipping
   * "forward" to a track above the one on screen. Ungrouped torrents come back
   * in plain ascending order, exactly as before.
   */
  function orderedIndices(torrent) {
    return memoized(torrent, 'ordered', function () { return computeOrdered(torrent); });
  }

  function computeOrdered(torrent) {
    var files = (torrent && torrent.files) || [];
    var playable = function (i) { return files[i] && MP.util.isPlayable(files[i]); };
    // Uniform over grouped and ungrouped: an ungrouped torrent is one group, and it
    // needs the same within-record ordering. The old short-circuit returned plain
    // ascending file order here, which is precisely how a single-album torrent whose
    // files were out of order got played in the wrong sequence.
    return group(torrent).groups.reduce(function (out, g) {
      return out.concat(g.indices.filter(playable));
    }, []);
  }

  /**
   * Every media file, in the order the list shows them.
   *
   * The track list used to walk `files` directly and drop each row into its group,
   * which quietly made display order equal file order regardless of what grouping
   * had decided. This is the one order both it and the queue read.
   */
  function mediaOrder(torrent) {
    var files = (torrent && torrent.files) || [];
    return group(torrent).groups.reduce(function (out, g) {
      return out.concat(g.indices.filter(function (i) {
        return files[i] && MP.util.isMediaFile(files[i]);
      }));
    }, []);
  }

  window.MP = window.MP || {};
  window.MP.albums = {
    group: group,
    orderedIndices: orderedIndices,
    mediaOrder: mediaOrder,
    trackOrderKey: trackOrderKey,
    discNumber: discNumber,
    DISC_ONLY: DISC_ONLY,
    ROOT_KEY: ROOT_KEY,
    albumSegment: albumSegment,
  };
})();
