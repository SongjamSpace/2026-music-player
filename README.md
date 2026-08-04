# 2026 Music Player

A personal music-first media player that streams and downloads torrents via magnet links.

**Repo:** [SongjamSpace/2026-music-player](https://github.com/SongjamSpace/2026-music-player)

## Install as a Mac app

```bash
npm install
npm run install-app     # builds, then copies to /Applications
```

Then launch it from Spotlight, Launchpad or the Dock like any other app —
no terminal needed. `npm run build` alone leaves the bundle in `dist/`.

The build is **ad-hoc signed**, not notarised: it's a personal build, and Apple
silicon refuses to launch unsigned native code at all. Because it's built
locally it carries no quarantine flag, so Gatekeeper doesn't prompt. If you ever
move it between machines, right-click → Open the first time.

The packaged app and `npm start` deliberately share one data directory
(`~/Library/Application Support/2026-music-player`), so your library, presets
and cached torrent metadata are the same in both.

## Run from source

```bash
npm install
npm start
```

If Electron fails to start with "Electron failed to install correctly", remove and reinstall:

```bash
rm -rf node_modules/electron
npm install
```

**Launching from a VS Code terminal?** The extension host exports
`ELECTRON_RUN_AS_NODE=1`, which makes Electron boot as plain Node. From source
that fails loudly with `Cannot read properties of undefined (reading
'whenReady')`; the packaged app fails *silently*, exiting 0 with no window and
no error, because Node is handed no script to run. `open` forwards your shell
environment, so this bites there too. Either use a normal Terminal window or
unset it:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
env -u ELECTRON_RUN_AS_NODE open -a "2026 Music Player"
```

Launching from Finder, Spotlight or the Dock is unaffected — `launchctl getenv
ELECTRON_RUN_AS_NODE` is empty, so LaunchServices never sees it.

### Debugging

```bash
MP_DEBUG=1 npm start      # mirror renderer console output into the terminal
MP_DEVTOOLS=1 npm start   # open DevTools detached
```

## Usage

1. **Add Magnet** (or `⌘N`) — paste the link, or the whole page you copied it
   from; the magnet is picked out of the surrounding text. You can also drop a
   magnet anywhere in the window.
2. The torrent appears in the sidebar and starts downloading. A skeleton list
   shows while metadata is being fetched from peers.
3. Pick a torrent, then **double-click** a track to play it (single click
   selects, matching Music.app). Audio and video stream as they download — no
   need to wait for the whole file.
   Cover art comes from an image inside the torrent (`cover.jpg`, `folder.png`,
   or the largest image if nothing is conventionally named); failing that, it's
   read out of the audio file's own tags, which is where most releases actually
   keep it. Image files are used as artwork rather than listed as tracks.
4. Downloads go to `~/Music/2026-Music-Player` by default; change it in
   **Settings**. Added magnets are restored when you reopen the app.

### Audio effects

`E` (or the slider button beside the volume control) opens a parametric
equaliser and effects rack that processes playback live.

- **Parametric EQ** — up to 12 bands over a log-frequency curve with the live
  spectrum drawn behind it. Drag a node for frequency and gain, scroll to change
  Q, double-click empty space to add a band or a node to remove it, right-click
  for the filter type (bell / shelf / cut / notch). Every band is also editable
  as plain number fields in the list below, which is the keyboard-complete path.
- **Preamp** with an **Auto** button that sets it to cancel the loudest boost.
- **Dynamics** — compressor with a live gain-reduction meter, plus a brick-wall
  limiter that is **on by default** so EQ boosts can't clip.
- **Stereo width** — mid/side, mono through to 200%.
- **Crossfeed** — Bauer-style bleed between channels; eases hard-panned stereo
  on headphones. Leave it off on speakers.
- **Reverb** — convolution with an impulse response generated at runtime, so no
  audio assets ship with the app.
- Presets (Flat, Bass Boost, Vocal, Acoustic, Electronic, Loudness, Night, plus
  your own), A/B snapshots, and a global bypass that crossfades rather than
  cutting.

Everything except the limiter is off by default: the app sounds exactly as it
did before you touch a control.

### Keyboard

`Space` play/pause · `←`/`→` seek ±10s (`⇧` for ±30s) · `⌘←`/`⌘→` prev/next ·
`⌘↑`/`⌘↓` volume · `M` mute · `S` shuffle · `R` repeat · `⌘F` filter tracks ·
`⌘,` settings · `F` fullscreen video · `E` audio effects · `⌘⌥T` cycle theme ·
`?` full list.

With the EQ curve focused: `←`/`→` frequency, `↑`/`↓` gain, `[`/`]` Q,
`PgUp`/`PgDn` select band, `↵` type menu, `⌫` remove, `+` add.

Media keys and the macOS Now Playing widget work via `navigator.mediaSession`.

## Tech

- **Electron** – desktop shell
- **WebTorrent** – torrent client, and the HTTP streaming server used for content
  that is still downloading
- **`main/file-server.js`** – one long-lived loopback server for files already
  complete on disk, so a downloaded album plays without going through WebTorrent's
  piece store at all (see [Playing from disk](#playing-from-disk))
- **`main/library.js`** – the persistent album index, an append-only JSONL log under
  `<userData>/library/` (see [The library index](#the-library-index))
- **electron-store** – persists magnet URIs, download path, the library-root marker
  id, and a `prefs` object (theme, volume, shuffle/repeat, learned track durations,
  listen port, upload limit, piece strategy)
- **@silentbot1/nat-api** – UPnP-IGD / NAT-PMP port mapping. ESM-only, so it is
  reached through a dynamic `import()` from CommonJS main; this is also why the
  packaged build sets `asar: false` (Electron 28 can't dynamic-import ESM from
  inside an asar archive, and it fails only in the packaged app)

### Metadata cache

A magnet link contains no file list — that has to be fetched from a peer. So an
album you have already downloaded in full is still unopenable whenever its swarm
happens to be offline, which is the normal end state for an old torrent.

The `.torrent` is therefore cached to `<userData>/torrents/<infoHash>.torrent`
the first time metadata arrives, and `add()` prefers it over the magnet on every
later launch. The library then opens instantly and entirely offline, with zero
peers. Removing a torrent deletes its cached metadata too.

The one case this can't help is a torrent that has *never* connected to a peer:
there's nothing to cache yet. If its folder is already in the downloads
directory, the track list offers **Open from Downloaded Files**, which hashes
that folder into a local-only torrent (`announce: []`, so nothing is
advertised) and serves it through the normal pipeline. The library id stays
keyed to the original magnet via an alias map, and the generated `.torrent` is
cached as `<infoHash>.local.torrent` so it resolves instantly from then on.

Alongside it, `<infoHash>.modtimes.json` records each file's modification time
once the torrent completes. WebTorrent re-hashes every byte of every restored
torrent on launch unless it is given these, which means a library of finished
albums spends minutes saturating the same thread the downloader runs on, right
when you want to press play. With them, an untouched file set is trusted after
one `stat()` per file. (Not `skipVerify`, which trusts the disk blindly and
would happily serve a truncated file as valid audio.)

Note the limit: `fileModtimes` is **all-or-nothing**. WebTorrent requires a modtime
for every file (`lib/torrent.js` uses `.every()`), so a *partially* downloaded
torrent can never benefit from the cache no matter what is written — which is why
these are only recorded on completion. A library with three partial albums therefore
re-hashes those three in full on every launch, and the only real fix is not to add
them at boot.

## The library index

`<userData>/library/` holds an append-only JSONL log of one record per album: its
name, the files it contains, which of them are present on disk, and its state
(`downloading` / `seeding` / `idle` / `archived` / `missing`).

It exists because until it did, *the library was the set of live WebTorrent
objects*. There was nowhere else a file list could come from, so every album had to
be a running torrent just to be listed — and piece caches, wires, bitfields and
per-torrent HTTP servers all scale off that set. An index the UI can read without a
torrent being alive is the precondition for not keeping them all alive.

Append-only rather than one JSON blob, and deliberately not in electron-store:
`Store.set()` serialises and rewrites the whole file synchronously, and that file
also holds `prefs.durations`, which is written every time a track duration is
learned. An append is a few hundred bytes; a torn final line from a crash mid-write
is discarded and repaired on load. The log is compacted into `albums.snapshot` once
it outgrows the records it contains.

The index is rebuilt from nothing by `main/library-import.js`, using the cached
`.torrent` files plus one `stat()` per file — no network, no peers, no piece
verification. Measured on the real library that is 11 albums and 1,070 tracks in
~0.5 s. At the design target of 1,000 albums / 10,000 tracks the whole index is
1.2 MB and loads in ~5 ms, which is what makes holding it in memory the right call
rather than reaching for SQLite.

## Cover art

Extracted once per album, resized, cached on disk under `<userData>/artcache/`, and
handed to the renderer as a URL.

It used to be a base64 data URL, which meant the same unresized image existed three
times: as a ~1.37×-inflated string in a main-process Map that was never pruned, as
that same string again in a renderer Map after being structured-cloned across IPC, and
as a decoded bitmap in Chromium. A 3 MB embedded JPEG cost roughly 10 MB of process
memory per album, permanently. Now the renderer holds an ~80-character string and the
bytes sit on disk at 4 KB (96px) and 46 KB (512px).

Resizing uses Electron's own `nativeImage` rather than sharp or jimp, because this
project's packaging has no native-rebuild step. It is main-thread and ~10 ms per
image, so extraction runs through a concurrency-1 queue, on demand only, never as a
boot sweep. The cache is content-addressed, so replacing a cover produces a new URL
rather than being masked by a stale one — which is what lets the server mark art
`immutable`. It is LRU-pruned to 128 MB and an album's files are deleted when the
album is removed.

Small tiles ask for the 96px variant explicitly, because Chromium keeps a decoded
bitmap per distinct URL: a 512px image in a 48px tile is ~1 MB of bitmap for nothing.
With nothing needing `data:` URLs any more, `img-src` no longer allows them.

## Which torrents are live

`main/torrent-manager.js` owns lifecycle: which albums have a WebTorrent object at
all. Everything else about a torrent — client options, activation, the progress
ticker, the metadata caches — stays in `main/torrent-service.js`.

It exists because the app used to add every saved magnet at boot and never destroy a
completed torrent, so a live torrent existed for every album ever added. Each one
costs a piece cache, up to `maxConns` wires, a bitfield and an HTTP server, which is
why footprint tracked library size rather than activity.

| state | torrent | meaning |
|---|---|---|
| `downloading` | live | incomplete, counts against the cap |
| `seeding` | live | complete, counts against the cap |
| `idle` | none | complete on disk, but nothing cached to wake from |
| `archived` | none | complete, and we hold metadata — waking is instant and offline |
| `missing` | none | the files are not where the index says |

The policy:

- **Nothing is added at boot.** The UI renders from the index. Incomplete albums
  auto-resume *after first paint*, up to 3 at once, most-nearly-finished first.
- **A completed album seeds for 30 minutes, then archives.** That gives back when it
  is most useful to the swarm, without a standing cost. Two completed albums stay
  live at a time, oldest archived first.
- **An album that is actively uploading is never yanked.** The window extends while
  upload continues, up to a two-hour ceiling so a popular album cannot seed forever.
- **The album being listened to is never archived**, whatever the window says.
  Archiving closes that torrent's HTTP server, and a track streaming through it goes
  silent mid-song reporting only a generic `MediaError` — which is how this was first
  reported: as a complaint that one FLAC was an unsupported format, on a file that
  plays perfectly. `player.js` also swaps to the album's other source once per track
  before reporting anything, so a stream that dies falls back to the file on disk.
- **Waking is lazy and deduplicated.** Playing a track that is not on disk wakes its
  album; three concurrent callers produce one `add()`, because WebTorrent errors on
  adding an infohash it already has.
- **Nothing is woken when the drive is unavailable** — waking would have WebTorrent
  see 0% and re-download the album.

`archived` and `idle` are distinguished precisely because of that "instant and
offline" clause: with a cached `.torrent`, waking needs no peers at all.

Two things this breaks unless handled, and both are:

- The file server and *Reveal in Finder* both fall back to the index when there is no
  live torrent, or every archived album would become unplayable and unfindable.
- States are reconciled at startup. `downloading` and `seeding` describe a live
  torrent, and nothing is live when the process starts — so a crash or a quit
  mid-seed would otherwise leave those recorded and wrong for the whole next session.

Measured on the real library: 3 live torrents instead of 11, with all 11 albums
listed and playable. The 8 completed albums cost nothing, which is the property that
has to hold as the library grows.

## Playing from disk

A file that is already complete is read directly, by a single long-lived HTTP server
on `127.0.0.1` (`main/file-server.js`), instead of being streamed through
WebTorrent's per-torrent server. Only content that is still downloading goes through
the torrent path.

Loopback HTTP rather than a custom `mp://` protocol, for three specific reasons: the
CSP in `renderer/index.html` already allows `media-src http://127.0.0.1:*` (it also
now allows `connect-src`, so the renderer can ask the server directly why a load
failed instead of guessing); `installStreamCorsHeaders()` already pins
`Access-Control-Allow-Origin` onto loopback responses, which the DSP graph depends on
because the renderer's origin over `file://` is the string `"null"`; and
`fs.createReadStream({start, end})` is the well-trodden way to serve the HTTP 206
Chromium needs to seek inside a FLAC.

Because it listens on loopback, every path carries a session token regenerated each
launch — the loopback interface is not a permission boundary, and without one any
local process could enumerate the library by walking `/media/<id>/0`. Resolved paths
are `realpath`-checked against the album root, since `..` in a torrent's file paths
is a known bad-torrent trick.

The bar for serving a file locally is *known* complete, never "probably": a local URL
for a partially written file would play silence or noise. `torrent.done` is O(1) and
covers a finished album; individual files fall back to the memo the progress ticker
already maintains.

### Where the window opens

Electron with no `x`/`y` centres on whichever display macOS calls primary, at a fixed
1180×780 — so on a multi-display desk the app opened small, on the wrong screen, every
launch. `main/window-state.js` decides instead:

1. reopen where it was last closed, if that place still exists;
2. otherwise fill the **leftmost** display's work area.

Rule 1 has to be conditional, and that is why this is a module with a harness rather
than four lines in `createWindow`. Saved coordinates describe an arrangement that may
be gone — unplug the monitor the window was on and restoring puts it somewhere with no
screen, invisible and impossible to drag back. The test is what fraction of the window
lands on *any* display, summed rather than best-of, because a window deliberately
straddling two screens is fully visible and must not be moved. Below 30% it is treated
as lost.

`workArea`, not `bounds`, so the window sits under the menu bar rather than behind it.
Normal bounds are saved, never the maximized rectangle — that would restore a window
that cannot be un-maximized to anything sensible. Full screen is deliberately not
remembered: `F` toggles it for video, and reopening into it hides the traffic lights.

Two things learned in verification, both about *when* the state can be read:

- Bounds are captured in memory on every move and resize, and only written to disk
  debounced. Reading at quit time looked right and silently saved `null` — by
  `before-quit` the window is already destroyed, so a resize inside the last 400ms
  was lost.
- The write is skipped when nothing changed. `move` fires per frame of a drag and
  every `store.set` is a synchronous rewrite of `config.json`.

`scripts/window-state-check.js` describes arrangements as rectangles, so a monitor
being unplugged between launches — the failure that matters — is testable without
three monitors.

### Track order

Album *grouping* reads folders; track order reads filenames. They are independent, and
one album made that obvious: *Isn't It Now?* arrived `03, 07, 08, 05, 01…` because a
torrent's file order is whatever the packager's filesystem happened to return. The
filenames were the only statement of intent in the torrent, and nothing was reading
them.

`albums.js` derives a sort key from each filename and orders within each group by
(disc folder, key, file index). Recognised: `05. Title`, `1-05 Title`, `A2 Title`, and
a bare numeric field after the artist — `Gang Gang Dance - 08 - Retina Riddim`, which
left a whole discography scrambled until it was handled.

What it refuses to read as a track number matters more than what it accepts, because a
wrong guess reorders a record that was already right:

- four digits is a year (`1984 Overture`, `2049 Blade`), not a track;
- a number inside a field is part of the title (`Miles Davis - Take 5`);
- no separator means no claim (`99Luftballons`).

Two safety properties. The sort is **stable**, so a torrent already in order comes out
untouched — only demonstrably misplaced files move. And a group is reordered only if
**two thirds** of its files claim a number and at least two claims differ; below that
it keeps file order, which is what leaves an unnumbered release like Gang Gang Dance's
`RAWWAR` alone instead of shuffling it.

The track list renders from `mediaOrder()` rather than walking `files`. It used to do
the latter and append each row into its group, which quietly made display order equal
file order no matter what grouping decided — so the list, the `#` column and the play
queue can no longer disagree.

### Damaged files

There is one gap in that, and it has been hit. When the index is rebuilt from a
cached `.torrent`, `verified` means only *a file of exactly the right length exists
at that path* — see the note in `library-import.js`. It cannot mean more without
hashing gigabytes off USB on every import, which is the boot cost the whole design
exists to avoid. But a full-length file whose bytes were never written — a crash
mid-write on exFAT, which has happened here — passes that test.

The symptom is specific and was reported as something else entirely: a track plays
perfectly and then dies partway through, always at the same place, and the player
calls it an unsupported format. It isn't. `flac -t` on the file that prompted this
reported `FRAME_CRC_MISMATCH after processing 12999168 samples` — 294.8 s in, which
is exactly where playback stopped. The whole file was buffered by then, so nothing
about the transport was involved.

So `player.js` distinguishes a track that never started from one that stopped
partway. The second offers **Re-download**, which clears `verified`, drops the
album's cached modtimes and puts the torrent back up. Dropping the modtimes is
load-bearing: that cache asserts "untouched since verified", and with it in place
webtorrent skips hashing, calls the album complete and re-downloads nothing.

The cost is honest but real: webtorrent's verification is per-album, so repairing
one track re-hashes the whole album and the album reads as incomplete until that
finishes. On a 6 GB discography over USB that is minutes cold, under a minute with
the page cache warm.

A file that is simply *gone* — deleted by hand, a folder renamed — is handled
without being asked. The file server reports the 404 to main, which clears
`verified`, drops the modtimes and wakes the torrent; the renderer says so and
resumes the track once the bytes arrive. Three things that took a second pass:

- Reacting to the 404 rather than sweeping at boot. A `stat` per track against USB
  every launch is exactly the startup cost this design removed, and it would only
  find what the next play attempt finds anyway.
- `safeJoin` returns null both for a missing file and for a path that escapes the
  album root. Only the first is reported — otherwise a crafted torrent file path
  could drive an index write and a torrent wake from outside.
- An unmounted drive 404s every track at once. The root is checked before anything
  is marked, because those flags persist: a library that was merely unplugged would
  otherwise come back claiming thousands of files needed re-downloading.

The retry hangs off `torrent:files:<id>` as well as the progress topic. Progress
alone was wrong — that ticker runs for live torrents only, so an album that failed
to wake would never fire it and the retry would wait forever.

### Repairing a damaged track

When a release is damaged at source, the app can patch the file: ffmpeg's decoder
skips the unreadable frame where Chromium stops dead, and re-encoding what it produces
gives a file that decodes all the way through. A FLAC frame is ~100 ms, so the
discontinuity is inaudible — but it is a patch, not a restoration, and nothing in the
UI claims the lost audio came back.

The repaired copy is written **beside** the original as `<name> (repaired).flac`, and
the index points playback at it. That is what keeps the album in the swarm: the
torrent's own file stays byte-intact and still hashes as valid, so seeding continues
and the album still reads 100%. Overwriting would force the "replaced by hand"
lockout below.

- **ffmpeg is not bundled.** It is ~70 MB and would need signing alongside the app, so
  `main/repair.js` looks for an installed one and the UI offers Repair only when it
  finds one. A GUI app inherits almost no `PATH` on macOS, so the Homebrew prefixes are
  checked explicitly rather than shelling out to `which`; `MP_FFMPEG` overrides.
- **Lossless only.** Patching a lossy file means re-compressing the whole track to fix
  one frame, and lossy decoders glitch through damage rather than stopping.
- **Always `.flac` out**, whatever went in. A `.wav` name holding FLAC bytes would be
  served as `audio/wav` from the extension map and Chromium would refuse it.
- **Verified before it is recorded**, with `flac -t` when installed — that checks every
  frame's CRC, which is exactly the failure being repaired. A result under half the
  original size is rejected: that means ffmpeg stopped at the damage rather than
  skipping it, which would be a worse file presented as a fix.
- Written to a `.part` file in the same directory and renamed, so the destination is
  never a half-written file the index already points at. `-f flac` is explicit because
  ffmpeg refuses to infer a format from `.part`.

Two ordering bugs worth knowing about, both found in verification:

- `resolveMedia` checks the repaired sibling **before** the live torrent. Asking the
  torrent first sent playback back to the file that stops halfway whenever the album
  happened to be seeding — which is most of the half hour after it completes.
- A live torrent's payload knows nothing about the index, so `withIndexOverlay` applies
  `repaired`/`substituted` and the local URL to it. Without that the UI forgot both for
  as long as the album was live, and playback lost the sibling with it.

### Replacing a track by hand

When a release is damaged at source, re-downloading cannot help — every peer has the
same bytes. The fix is to find a clean copy of that one track and drop it into the
album folder under the same name, and the app's job is then to get out of the way.

A track marked `substituted` is served from disk regardless of length, counts as
present so the album reads complete, and is never re-downloaded. The album will not
go live at all: waking it would have webtorrent hash the album, find the piece
covering that file failing, and download over the user's copy. There is no per-file
way to opt out that also lets an album report itself complete, so seeding, resuming
and the reachability check all refuse with the reason. Removing and re-adding the
album is the way back to the release's own file.

Detection is at serve time, from the `stat` the file server already performs, and the
rule needs **both** halves:

- the index previously vouched for the track (`verified`), and
- no torrent is live for the album.

The first half was learned by getting it wrong. Judging on length and liveness alone
marked **74 tracks of a 1%-downloaded album** as hand-replaced on the first run —
they were half-written from an earlier session, and nothing is live during boot.
Because a substituted track is never re-downloaded, that would have stopped those
albums finishing, silently and permanently. `classifyTrackFile` in
`library-import.js` holds the rule and `library-check.js` pins both directions;
`reconcileUnverifiedTracks` clears the flag where it cannot be true, so an index
written by the broken version heals itself on the next launch.

A matching size is reported too, not just a mismatch: when the release's own file
comes back the substitution has to be un-recorded, or the album would stay out of the
swarm on the strength of a file that is no longer there.

Media and cover art have separate concurrency budgets, not one shared pool. They
shared one at first, which meant a screen full of art could take every slot and a
media read would answer 503 — arriving at the renderer as a bare `MediaError`,
indistinguishable from a real playback failure. Playback must never be able to lose
a descriptor to a thumbnail. `range-check.js` saturates art and asserts a media read
still gets served.

## Download speed

The torrent client is tuned rather than left at library defaults, because those
defaults are conservative in ways that cost real throughput.

- **Fixed listen port**, chosen at random once per install and persisted. An
  ephemeral port can't be forwarded, and peers that learned the address via DHT
  or PEX can't reconnect after a restart. If the port is already taken — usually
  a second copy of the app — it falls back to an ephemeral one for that session
  and says so in Settings, because a failed listen makes WebTorrent destroy the
  whole client and nothing downloads at all.
- **Router port mapping** via UPnP-IGD or NAT-PMP (`main/nat.js`). Without an
  open port the client is outbound-only: invisible to everyone who finds it
  through DHT, PEX or a tracker. On the small swarms an album lives on that is
  frequently the difference between three peers and twenty. Every call is
  deadline-guarded — a router that ignores SSDP simply never answers — and
  failure is reported with the specific thing to go fix. NAT-PMP and UPnP are
  attempted as separate single-protocol clients rather than together, purely so
  the UI can say *which* one worked; that matters when it later stops working.

  A mapping succeeding is not the same as being reachable, so three things are
  detected and reported distinctly: **CGNAT** (the ISP handed the router a
  `100.64/10` address, so there is no public address to forward), **double NAT**
  (the router's WAN address is private), and **VPN egress**. The last one is the
  easy trap: VPN clients install `0.0.0.0/1` and `128.0.0.0/1` routes that beat
  the default route without replacing it, so the gateway still looks like the
  LAN router while every packet leaves through a tunnel — and the port forward,
  though real, is not in the path. That is detected locally by asking the kernel
  which source address it would use to reach the internet (`connect()` on a UDP
  socket performs the routing lookup without sending a packet), so there is no
  third-party IP-echo service involved.

  None of these are reported as "peers can't reach you", because that isn't
  reliably true — inbound connections do arrive in some VPN and CGNAT setups.
  The mechanism goes in Settings; the verdict comes from the live inbound peer
  count in the Connection panel, which is the only real evidence.
- **Default trackers** (`main/trackers.js`). A magnet carries only the `tr=`
  params whoever made it chose to include, often none. A curated list is merged
  into every add and refreshed daily from `ngosang/trackerslist`, cached to
  `<userData>/trackers.txt` so it works offline. `ws://` trackers are excluded:
  they return only WebRTC peers, which a Node client can't dial.
- **`maxConns: 60`** per torrent, up from WebTorrent's 55. It was 120; each wire
  carries its own read/write buffers and a bitfield, and that cost multiplies by the
  number of live torrents.
- **A per-torrent piece-cache budget** rather than a flat slot count
  (`main/tuning.js`). `storeCacheSlots` looks like a harmless integer and is not: it
  is the size of an LRU of *whole pieces*, so a flat 64 slots charged a 4 MB-piece
  torrent 256 MB and a 256 KB-piece one 16 MB — a 16× spread nobody chose. Budgeting
  bytes instead took the predicted worst case across the real library from 552 MB to
  108 MB. `npm run check` fails if that budget regresses.
- **A default upload cap of 1.5 MB/s**, which sounds backwards but isn't — a
  saturated uplink queues the TCP acknowledgements your *downloads* depend on.
  Configurable in Settings. Never set it to zero: peers reciprocate.
- **Whole-torrent download with playback priority**, not current-track-only.
  Restricting to two files leaves most peers with nothing to send you; breadth
  is what makes a swarm fast. The playing track, the next one and the cover art
  get explicit priority on top (`main/torrent-service.js`).
- **Hybrid piece strategy** (`main/piece-policy.js`). Sequential while the play
  head is exposed, rarest-first once there's runway, with a wide hysteresis band
  so it can't flap. Rarest-first is what earns unchokes; sequential is what
  avoids stalls.

  With one hard limit on top: **rarest-first is only applied to torrents small
  enough that WebTorrent's rarity scan is cheap.** `rarity-map.getRarestPiece()`
  scans every piece in the torrent per call, `trySelectWire()` calls it in a loop
  over the whole selection span, the filter it passes loops every wire, and
  `_update()` runs all of that per wire from eight separate wire events. On a
  5,847-piece discography a V8 CPU profile attributed ~14% of wall clock — ~85% of
  all non-idle JS — to that one path, with event-loop stalls over a second. It also
  grew native memory ~15 MB/min, because the picker kept starting pieces it never
  finished and each holds 16 KB block buffers. Bounding it took the main process from
  49% of a core to 6%, and max event-loop lag from 1386 ms to 3 ms, at the same
  download speed.
- **A 30-second readahead window** around the play head, replacing WebTorrent's
  two-piece one. The critical set is garbage-collected on every tick, which the
  library itself never does — left alone it grows for the life of the torrent
  and burns bandwidth on duplicate block requests.

**Settings → Network** shows whether the port is mapped and, when it isn't, what
to do about it. The **Connection** panel under any album header names the actual
bottleneck: no inbound peers means the router; few peers all sending means the
swarm is just small and there is nothing to fix.

### Which way traffic actually leaves

A port forward is worthless if packets don't go through the router that has it.
VPN clients install `0.0.0.0/1` and `128.0.0.0/1` routes, which beat the default
route without replacing it — so the gateway still *looks* like the LAN router
while every packet leaves through a tunnel. `main/net-path.js` measures the real
answer instead of inferring it, and Settings → Network reports it.

- **Traffic path** — the interface actually in use, from a `dgram` `connect()`
  that performs the routing lookup without sending a packet.
- **Interface reachability** — per interface, a TCP connect to `1.1.1.1:443`
  with `localAddress` set. Two IP-literal targets so a single filtered anycast
  host can't be mistaken for a dead interface, no hostname so a tunnel-bound
  resolver can't poison the result, and `ECONNREFUSED` counts as *reachable*
  because something answered. Each interface's gateway is probed separately,
  which is what distinguishes "cable unplugged" from "cable fine, routes point
  elsewhere".
- **Expect traffic to leave via** — a check, not a switch. It moves no traffic;
  it tells the app which situation to warn about. `VPN preferred` is the
  split-tunnel mode: VPN up with torrents direct reads as success, the VPN
  dropping is a neutral notice (downloads continue), and torrents being pulled
  back into the tunnel is the warning, because that's when inbound peers vanish.
- **Home network** — fingerprinted by the router's MAC from the local ARP cache,
  because every home router is `192.168.x.1` but the MAC is specific. Used for
  one thing: going direct on a network you haven't vouched for is flagged, and
  that flag outranks every other verdict.

Nothing here contacts an outside server except **Check public IP**, which is a
button and is never pressed on your behalf.

```bash
node scripts/net-path-check.js      # ground truth in ~1s
```

### The listen port is the whole ballgame

If downloads sit at 0 B/s on a torrent that clearly has seeders, this is almost
always why, and no amount of client tuning touches it.

**A peer behind NAT cannot connect to another peer behind NAT.** One side has to
be able to *accept* a connection. Big public swarms contain seedboxes with open
ports, so you can always dial someone. A small album swarm is entirely
residential clients — if you also have no open port, there is nobody either of
you can reach. Measured on this machine, speed tracks exactly one number, the
fraction of a swarm that will accept a connection, and tracks nothing else:

| swarm | seeders | addresses | dialable | speed |
|---|---|---|---|---|
| Ubuntu 26.04 | 2737 | 60 | 9 (23 %) | 25–35 MB/s |
| Daft Punk | 50 | 45 | 3 (8 %) | 3.4 MB/s |
| GTA V | 5 | 4 | 1 (25 %) | completed, 2.3 GB |
| Kill Bill | 9 | 48 | **0** | frozen at 23 % |

Not seeder count. Not tracker health, DHT node count, connection limits or piece
strategy. Only reachability.

**So get an open port and put it in Settings → Network → Listen port.** The only
reliable source of one behind CGNAT is a VPN provider that offers port
forwarding — AirVPN, ProtonVPN (paid) and PIA do; NordVPN does not, on any
platform. Set the app's listen port to the port your provider forwards you, and
restart. Router UPnP is skipped automatically whenever traffic egresses a
tunnel, because the router is not in the path and claiming a mapping there would
be a lie.

**The proof is inbound peers, not a config screen.** Settings reports
*"N peers have connected in on port 48764"* — that sentence can only be true if
the forward really works. When it reads *"No incoming connections yet"*, check
the forwarded port in your provider's control panel still matches.

This one change took two torrents that had written zero bytes in two hours to
80 % and 18 % within minutes, with seeders finally dialing in.

**Why there is no "bypass the VPN" switch.** Node exposes only source-address
binding (`localAddress`), which does not change route selection — a socket bound
to the LAN address still tries to egress the tunnel and is refused
`EHOSTUNREACH` in about a millisecond. `ping -S`, `curl --interface` and the
app's own preflight all agree. Per-application split tunnelling is also
unavailable on macOS: Apple's `pf`, unlike FreeBSD's, has no `user`/`group`
match, so no `route-to` rule can mean "this app". A control that looked like it
moved traffic would be a lie, so there isn't one.

### When a torrent still won't move

Press **Check reachability** in the Connection panel under any album. It asks
the trackers who is in the swarm, then tries to open a connection to each one,
and reports what it found:

```
16 peers known · 2 of 16 reachable (12%) · tracker says 13 seeds / 3 leech · fastest 242ms
```

`0 reachable` with a healthy seeder count means every peer is behind a NAT that
won't accept connections — which, if your own port is forwarded, means the swarm
genuinely cannot serve you and nothing in this app can change that. That is a
real answer, and it is better than a silent 0 B/s.

### Peer encryption

On by default. MSE/RC4 obfuscation, which makes the protocol harder for an ISP
to fingerprint and throttle. Three things it is not:

- **Not privacy.** Every peer still sees your address, and DHT and tracker
  traffic are in the clear regardless.
- **Not universal.** WebTorrent only runs the encryption handshake for TCP
  peers; uTP peers are plaintext by construction.
- **Not all-or-nothing.** A peer whose encrypted connect fails is retried in the
  clear, so the encrypted fraction never reaches 100%.

Settings reports it as `12 of 18 TCP peers encrypted` — out of the peers that
*could* be encrypted, not out of all of them, so uTP and web seeds don't make a
working setting look broken. Toggling is restart-only in both directions:
`enableSecure()` flips a module-level global in webtorrent with no way to unset
it, and the row says so rather than pretending the change took.

```bash
node scripts/net-path-check.js --encryption 90   # measure it against a real swarm
```

### Measuring it

```bash
npm run check                # every no-network, no-running-app harness
npm run mem                  # footprint + swap, per process
node scripts/mem-check.js --cpu 60   # average CPU over a real window
npm run check:library        # index vs. the actual drive (needs it mounted)

npm run dev:debug            # then, against the running app:
npm run playback             #   does a downloaded album really play from disk?
node scripts/cpu-profile.js 25       # V8 profile of the main process

node scripts/net-probe.js --torrent ubuntu --profile tuned    # or baseline
```

Two notes on measuring this app specifically, both learned the hard way:

**Never use `ps -o rss`.** macOS compresses and swaps, so a process with a 1.93 GB
footprint reported ~160 MB of RSS — which is why a memory problem this large looked
like a small one for a long time. `mem-check.js` reads `top`'s footprint and
`vmmap`'s swapped-out figure instead, and reports the swap number explicitly,
because pages being compressed is what actually produces the beachball.

**Never quote a single CPU sample.** Two `top` samples of the same process a second
apart measured 52% and 1.5%; the work arrives in bursts of piece verification and
wire encryption. `--cpu N` accumulates CPU-seconds over a fixed wall-clock window,
which is the only number worth comparing between builds.

`sample(1)` is also not enough to find a hot spot here: every hot frame is
JIT-compiled JavaScript, so it symbolises as a bare address and tells you only "it's
in JS". `cpu-profile.js` attaches the V8 profiler over the inspector and names the
function and line — which is how the rarest-first picker was found.

**A flat JS heap does not mean flat memory.** The heap sat at 24 MB while the process
grew to 2.7 GB, because WebTorrent's block buffers are Node `Buffer`s living outside
V8. In `vmmap` they show up as *Memory Tag 255*, which is the number to watch;
`get-metrics` reports `arrayBuffers` and started-but-unfinished piece count for the
same reason.

### Known: Buffer growth under sustained high throughput

At a steady ~180 KB/s the main process holds flat (measured 97→108 MB over five
minutes, the rise tracking wire count). Under a sustained burst — 13.5 MB/s with 35
wires onto the external drive — it grew from 60 MB to ~300 MB over nine minutes and did
not fall back when the burst subsided. The JS heap stayed at 19 MB throughout, so the
growth is Buffer memory (Tag 255: 71 MB dirty plus 204 MB swapped).

For scale, that is roughly a ninth of the original problem at seventy times the
throughput, and event-loop lag stayed at 7–11 ms, so nothing beachballs. But it is not
flat, and the most likely explanation is the write-back queue: pieces arrive faster than
an exFAT USB volume can absorb them. If it needs chasing, bound WebTorrent's pending
write queue, and use `startedPieces` in the Net panel to confirm the diagnosis before
changing anything.

`net-probe` reports bytes verified to disk over a fixed window after a warmup.
Don't tune against `torrent.downloadSpeed` — it is a five-second trailing
average of raw wire bytes including duplicates and reads zero between bursts.
`--profile baseline` reproduces the original zero-option client, so runs are
directly comparable; alternate A/B/A/B rather than doing all of one then all of
the other, since swarm population drifts over tens of minutes. `MP_TORRENT_PROFILE=baseline`
does the same thing to the real app.

`selection-check` guards the playback-priority diff. The bug it exists for was
invisible: `file.select(1)` paired with a `file.deselect()` hardcoded to
priority 0 never matched, so every play, seek and shuffle appended another
permanent entry to an array that gets re-sorted on every piece update. Two
hundred track changes left 533 selections behind; the fix holds at 3.

The other harnesses guard things that are equally invisible until they aren't:

- `library-cost-check` prices the piece caches against the real `.torrent` files and
  **fails the build over a budget**, because `storeCacheSlots` is an integer whose
  real cost you cannot see without knowing your own piece lengths. It also
  cross-checks the fast bencode piece-length reader against `parse-torrent`.
- `library-root-check` is the decision table for the unmounted-drive guard — the one
  failure that would otherwise re-download the entire library.
- `range-check` boots the file server against a fixture and asserts byte-exactness,
  inclusive `Content-Range`, 416, `HEAD`, path traversal and descriptor leaks. An
  off-by-one there means audio that plays but cannot seek, which reads as a UI bug.
- `library-check` covers the index's failure modes: a torn final line from a crash
  mid-append, an interrupted compaction, a resurrected deletion, and load time at
  1,000 albums.

## Renderer architecture

No build step. `npm start` is the only command.

ES modules and `fetch()` don't work over `file://`, which `loadFile()` gives us,
so the renderer is a set of **ordered classic `<script>` tags sharing a
`window.MP` namespace**, and row markup lives in `<template>` elements cloned
per row rather than in string concatenation.

```
renderer/
  index.html            shell + <template> row definitions
  css/
    tokens.primitives.css   raw values (color ramp, type/space scales, motion)
    theme.midnight.css      semantic tokens — the dark default
    theme.daylight.css      light theme + `data-theme="auto"`
    base.css layout.css sidebar.css tracklist.css transport.css
    states.css dialogs.css toast.css
  js/
    namespace.js util.js icons.js theme.js artwork.js
    store.js              topic-scoped state
    api.js                the ONLY caller of playerAPI.on*
    actions.js player.js main.js
    audio/ dsp-defaults.js  pure data + normalise(); no DOM, no AudioContext
           ir.js            algorithmic reverb impulse response
           graph.js         owns the AudioContext and every node
           dsp.js           façade: prefs, CORS probe, presets, lifecycle
    ui/  sidebar.js torrent-header.js tracklist.js transport.js
         dialogs.js toast.js menu.js empty.js shortcuts.js
         eq-canvas.js dsp-panel.js
```

Three rules hold the thing together:

**Theming.** Component CSS may only reference semantic `--color-*` / `--glass-*`
tokens. A raw hex or an `--mp-*` primitive in a component file is a bug — it
won't follow the theme. Adding a theme is one CSS file, one `<link>`, and one
entry in `MP.theme.list()`. The boot theme is passed synchronously via
`webPreferences.additionalArguments`, because `script-src 'self'` forbids the
usual inline bootstrap and async IPC would flash the wrong theme.

**Rendering.** Lists are keyed row components that hold element references and
update in place; reordering uses `appendChild`, which moves an attached node.
The 1 s progress tick emits only `torrent:progress:<id>`, each row early-outs
on unchanged rounded values, and meters animate `transform: scaleX()` rather
than `width`, so a steady-state tick does no layout at all.

Anything on a per-interaction or per-tick path must be O(1) in list length, not
O(n). Selection and the playing-track highlight touch only the rows that changed,
the visible-index list is cached rather than re-queried, and a progress refresh
early-outs entirely when the tick carried no new per-file data — which is three
ticks in four. Album bodies get `content-visibility: auto`, so offscreen rows cost
nothing to lay out.

**There is deliberately no list virtualization**, and that is a measured decision
rather than an omission. With the 242-file Aphex discography open — 221 rows, 5,275
DOM nodes — an arrow keypress costs 0.23 ms, a four-character typeahead 0.8 ms, and
forcing layout of the whole list 0.10 ms. Windowing would trade that for a real
accessibility regression (a windowed listbox cannot keep `role="group"` around album
bodies, and `aria-setsize` over recycled rows is a known-hard problem) in exchange
for latency nobody can perceive.

The number to watch is not tracks per album — the track list only ever shows one
album — it is albums in the sidebar. Measured with a synthetic 1,000-album library:
1,011 rows, 15,277 nodes, filtering 0.3 ms, selecting 2.0 ms, and about 62 KB of
renderer memory per album. Comfortable well past a thousand albums. The cost that
does scale is building those rows at startup, ~0.8 ms each, and that is DOM node
creation — `content-visibility` was tried there and made no measurable difference,
because layout was never the expensive part. If the sidebar ever needs to get
cheaper, windowing *it* is the lever, and those are the numbers to beat.

**Stacking.** Every `z-index` comes from the `--z-*` scale in
`tokens.primitives.css`, so the order is legible in one place. Toasts are the
exception and deliberately have no place in it: the container is a
`popover="manual"` promoted into the browser's **top layer**, because modal
`<dialog>`s live there too and no z-index can beat them. Top-layer order is
order of entry, so the stack re-promotes itself on every toast. Panels call
`MP.toast.reserve(key, rect)` to declare the space they occupy and the stack
slides clear rather than overlapping — falling back to overlapping, still on
top, when the window is too narrow to dodge.

**Overlays.** The titlebar is a 52px `-webkit-app-region: drag` strip. That
region is handed to the OS, which hit tests it *before* the page sees the event,
so a floating panel overlapping it is dead to clicks no matter how high its
z-index. Every `<body>`-level overlay must declare `-webkit-app-region: no-drag`
— the list lives next to the titlebar rule in `layout.css`.

**Web Audio.** A `MediaElementAudioSourceNode` on CORS-tainted media outputs
silence, and adopting an element is irreversible — a second call throws, and
closing the context doesn't release it. So the media elements load with
`crossorigin="anonymous"` (set from JS, never in the HTML, so it stays
revocable), the main process forces `Access-Control-Allow-Origin: *` on the
loopback stream servers, and before the real elements are ever touched a
throwaway element is probed for signal. If any of that fails, `crossOrigin` is
dropped and playback continues without effects.

Nothing about that failure is remembered, and this is deliberate. `MediaError`
cannot tell a cross-origin refusal from a 404, a 503 or an unplugged drive — they
are all code 4 — so treating the code as proof of a CORS problem meant one
unrelated load failure wrote `corsOk: false` to disk and killed the effects chain
for every future launch, with nothing in the UI to undo it. That is much easier to
hit now that a torrent can be archived and its `streamURL` go stale. So `corsOk`
is only written by `confirmCorsFailure()` in `player.js`, which asks the network
instead of the error code: a `cors` fetch of the same URL, and if that rejects, a
`no-cors` one. Only *reachable under `no-cors`, refused under `cors`* implicates
CORS. A failed probe is a runtime fact — it retries on the next track, up to three
times a session, and the panel banner carries a **Try again** that reloads the
current track so the element can be re-adopted with `crossorigin` set.

Modules are disabled by setting neutral parameters rather than rewiring: a
peaking biquad at 0 dB is exactly unity, so "off" is genuinely transparent.
Reverb is the one exception — a convolver runs regardless of its output gain, so
its input is disconnected. The brief duck used for the few things that can't be
automated (filter type, IR swap) is reference counted against a declared resting
level: `AudioParam.value` is live during a ramp, so sampling it on entry let one
duck capture another's fade-out as "the level to restore" and leave the chain at
zero permanently.

**IPC.** `js/api.js` subscribes to each channel exactly once and fans out with
real unsubscribe functions. Nothing else may call `playerAPI.on*`: there's no
`removeListener` on the bridge, so a duplicate subscription can't be undone
without reloading the window — and `restore-magnets` adds a torrent per magnet,
so doubling it would add every saved torrent twice on launch.
