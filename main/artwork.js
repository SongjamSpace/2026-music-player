'use strict';

/**
 * Cover art: extracted once, resized, cached on disk, served by URL.
 *
 * What this replaces: art was read out of the audio tags and handed to the renderer
 * as a base64 data URL. That meant the same image existed three times over — as a
 * ~1.37x-inflated string in a main-process Map that was never pruned, as the same
 * string again in a renderer Map after being structured-cloned across IPC, and as a
 * decoded bitmap in Chromium once it hit an `<img>`. None of it was resized, so a
 * 3 MB embedded JPEG cost roughly 10 MB of process memory per album, permanently.
 *
 * Now: two JPEGs on disk per album, and the renderer holds URL strings. A 96px thumb
 * decodes to about 36 KB.
 *
 * Resizing uses Electron's own `nativeImage`, which is worth stating explicitly: it
 * avoids adding sharp or jimp, and this project's packaging has no native-rebuild
 * step (see the note about utp-native in main/torrent-service.js). It is main-thread
 * and roughly 10ms per image, so extraction runs through a concurrency-1 queue, on
 * demand only, and never as a boot sweep.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Two sizes, because the two uses have very different needs: a list tile is tiny and
 * wants to decode fast, the now-playing panel wants something that survives a
 * retina display.
 */
const VARIANTS = {
  thumb: { width: 96, quality: 78 },
  hero: { width: 512, quality: 82 },
};

/** Total disk budget for the cache. Pruned LRU by last use. */
const CACHE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Names that conventionally mean "this is the album cover", best first.
 * Kept in step with PREFERRED in renderer/js/artwork.js.
 */
const PREFERRED = ['cover', 'folder', 'front', 'album', 'artwork', 'art'];

const IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|avif|bmp)$/i;
const AUDIO_RE = /\.(mp3|m4a|flac|ogg|oga|opus|aac|wav)$/i;

/**
 * @param {object} deps
 * @param {string} deps.dir           Cache directory.
 * @param {object} deps.nativeImage   Electron's nativeImage module.
 * @param {object} deps.parseFile     music-metadata's parseFile.
 */
function createArtwork({ dir, nativeImage, parseFile }) {
  /** albumId -> {status, variants: {thumb, hero}, bytes, lastUsed, version} */
  const manifest = new Map();
  const manifestPath = path.join(dir, 'manifest.json');

  /** Serialises extraction. nativeImage resizing is synchronous and main-thread. */
  let queue = Promise.resolve();
  /** albumId -> promise, so concurrent tiles asking for the same album share work. */
  const inFlight = new Map();

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function variantPath(albumId, variant, version) {
    return path.join(dir, albumId + '-' + variant + '-' + version + '.jpg');
  }

  async function loadManifest() {
    ensureDir();
    try {
      const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      for (const [id, entry] of Object.entries(raw)) manifest.set(id, entry);
    } catch (_) {
      /* no manifest yet, or unreadable — the cache rebuilds on demand */
    }
  }

  /**
   * Written whole, which is fine: it is one small object per album, and unlike the
   * library index it is disposable — losing it costs a re-extraction, not data.
   */
  async function saveManifest() {
    ensureDir();
    const out = {};
    for (const [id, entry] of manifest) out[id] = entry;
    try {
      await fsp.writeFile(manifestPath, JSON.stringify(out));
    } catch (err) {
      console.warn('[artwork] could not write manifest:', err.message);
    }
  }

  /** Pick the most likely cover from a list of image file paths. */
  function pickCoverFile(imagePaths) {
    if (!imagePaths.length) return null;
    for (const wanted of PREFERRED) {
      const hit = imagePaths.find((p) => path.basename(p).toLowerCase().includes(wanted));
      if (hit) return hit;
    }
    // No conventional name — the largest file is almost always the cover rather than
    // a scan or a logo.
    let best = imagePaths[0];
    let bestSize = -1;
    for (const p of imagePaths) {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch (_) {
        continue;
      }
      if (size > bestSize) {
        bestSize = size;
        best = p;
      }
    }
    return best;
  }

  /**
   * Resize and re-encode. Returns bytes written per variant.
   *
   * A source narrower than the target is not upscaled — that would spend bytes to
   * add nothing — but it is still re-encoded, so the cache is uniformly JPEG and the
   * server never has to guess a content type.
   */
  async function writeVariants(albumId, sourceBuffer, version) {
    const image = nativeImage.createFromBuffer(sourceBuffer);
    if (image.isEmpty()) throw new Error('unreadable image data');
    const size = image.getSize();
    const written = {};
    let bytes = 0;

    for (const [name, spec] of Object.entries(VARIANTS)) {
      const target = Math.min(spec.width, size.width || spec.width);
      const resized = target < size.width
        ? image.resize({ width: target, quality: 'better' })
        : image;
      const buf = resized.toJPEG(spec.quality);
      const file = variantPath(albumId, name, version);
      await fsp.writeFile(file, buf);
      written[name] = path.basename(file);
      bytes += buf.length;
    }
    return { variants: written, bytes };
  }

  /**
   * Find cover art for an album and cache it.
   *
   * Prefers a real image file in the album folder over embedded tags, because it is
   * usually higher resolution and reading it costs one file read rather than parsing
   * an audio header.
   *
   * @param {object} album
   * @param {string} album.id
   * @param {string[]} album.imagePaths  Absolute paths to image files present on disk.
   * @param {string[]} album.audioPaths  Absolute paths to complete audio files.
   * @returns {Promise<{status: string, version?: string}>}
   */
  async function extract(album) {
    const coverFile = pickCoverFile(album.imagePaths || []);
    let source = null;

    if (coverFile) {
      try {
        source = await fsp.readFile(coverFile);
      } catch (_) {
        source = null;
      }
    }

    if (!source) {
      for (const audioPath of (album.audioPaths || []).slice(0, 3)) {
        try {
          const meta = await parseFile(audioPath, { duration: false, skipPostHeaders: true });
          const picture = (meta.common.picture || [])[0];
          if (picture && picture.data && picture.data.length) {
            source = Buffer.from(picture.data);
            break;
          }
        } catch (err) {
          console.warn('[artwork] could not read tags from', path.basename(audioPath), '-', err.message);
        }
      }
    }

    // Nothing to show, and nothing will change until the album does. Terminal.
    if (!source) return { status: 'none' };

    // Content-addressed, so a replaced cover produces a new URL rather than being
    // masked by a cached one — which is what lets art be cached hard by the server.
    const version = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
    const existing = manifest.get(album.id);
    if (existing && existing.version === version && existing.status === 'ok') {
      existing.lastUsed = Date.now();
      return { status: 'ok', version };
    }

    const { variants, bytes } = await writeVariants(album.id, source, version);
    if (existing) await removeFiles(existing);
    manifest.set(album.id, {
      status: 'ok',
      version,
      variants,
      bytes,
      lastUsed: Date.now(),
    });
    await saveManifest();
    await prune();
    return { status: 'ok', version };
  }

  async function removeFiles(entry) {
    for (const file of Object.values(entry.variants || {})) {
      try {
        await fsp.unlink(path.join(dir, file));
      } catch (_) {
        /* already gone */
      }
    }
  }

  /**
   * Keep the cache under budget, dropping least-recently-used albums first.
   *
   * Bounded on disk rather than in memory, which is the trade this whole module
   * makes: re-extracting a cover is cheap, holding every cover in RAM forever is not.
   */
  async function prune() {
    let total = 0;
    for (const entry of manifest.values()) total += entry.bytes || 0;
    if (total <= CACHE_BUDGET_BYTES) return;

    const byAge = [...manifest.entries()].sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [id, entry] of byAge) {
      if (total <= CACHE_BUDGET_BYTES) break;
      await removeFiles(entry);
      manifest.delete(id);
      total -= entry.bytes || 0;
    }
    await saveManifest();
  }

  return {
    load: loadManifest,

    /**
     * Art for an album, extracting it if needed.
     *
     * Returns a status rather than a nullable URL, because "nothing yet, ask again"
     * and "there is genuinely no art" are different and conflating them was a real
     * bug: the renderer cached the second meaning for the first, so art never
     * appeared for any album that was still downloading when its tile first rendered.
     *
     *   pending  nothing readable on disk yet — retry later
     *   none     looked, and there is no art — terminal
     *   ok       `version` identifies the cached files
     */
    async get(album) {
      const cached = manifest.get(album.id);
      if (cached && cached.status === 'ok') {
        cached.lastUsed = Date.now();
        return { status: 'ok', version: cached.version };
      }
      if (cached && cached.status === 'none') return { status: 'none' };

      // Nothing complete to read yet. Deliberately not cached — this is the
      // retryable case.
      if (!(album.imagePaths || []).length && !(album.audioPaths || []).length) {
        return { status: 'pending' };
      }

      if (inFlight.has(album.id)) return inFlight.get(album.id);

      const work = (queue = queue.then(() => extract(album)).catch((err) => {
        console.warn('[artwork] extraction failed for', album.id, '-', err.message);
        return { status: 'pending' }; // a failure is worth retrying, unlike 'none'
      }))
        .then(async (result) => {
          if (result.status === 'none') {
            manifest.set(album.id, { status: 'none', bytes: 0, lastUsed: Date.now() });
            await saveManifest();
          }
          inFlight.delete(album.id);
          return result;
        });

      inFlight.set(album.id, work);
      return work;
    },

    /** Absolute path for a cached variant, for the file server. Null if absent. */
    pathFor(albumId, variant) {
      const entry = manifest.get(albumId);
      if (!entry || entry.status !== 'ok') return null;
      const file = entry.variants && entry.variants[variant];
      if (!file) return null;
      entry.lastUsed = Date.now();
      return path.join(dir, file);
    },

    /** Drop an album's art — called when the album is removed from the library. */
    async forget(albumId) {
      const entry = manifest.get(albumId);
      if (!entry) return false;
      await removeFiles(entry);
      manifest.delete(albumId);
      await saveManifest();
      return true;
    },

    stats() {
      let bytes = 0;
      let ok = 0;
      let none = 0;
      for (const entry of manifest.values()) {
        bytes += entry.bytes || 0;
        if (entry.status === 'ok') ok++;
        else if (entry.status === 'none') none++;
      }
      return { albums: manifest.size, withArt: ok, withoutArt: none, bytes, budget: CACHE_BUDGET_BYTES };
    },
  };
}

module.exports = { createArtwork, VARIANTS, CACHE_BUDGET_BYTES, PREFERRED, IMAGE_RE, AUDIO_RE };
