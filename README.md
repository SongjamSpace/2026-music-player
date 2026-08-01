# 2026 Music Player

A personal music-first media player that streams and downloads torrents via magnet links.

**Repo:** [SongjamSpace/2026-music-player](https://github.com/SongjamSpace/2026-music-player)

## Run

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
`ELECTRON_RUN_AS_NODE=1`, which makes Electron boot as plain Node and fail with
`Cannot read properties of undefined (reading 'whenReady')`. Either use a normal
Terminal window or unset it:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

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
- **WebTorrent** – torrent client and HTTP streaming server (range requests for seeking)
- **electron-store** – persists magnet URIs, download path, and a `prefs` object
  (theme, volume, shuffle/repeat, learned track durations)

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
The 500 ms progress tick emits only `torrent:progress:<id>`, each row early-outs
on unchanged rounded values, and meters animate `transform: scaleX()` rather
than `width`, so a steady-state tick does no layout at all.

**Web Audio.** A `MediaElementAudioSourceNode` on CORS-tainted media outputs
silence, and adopting an element is irreversible — a second call throws, and
closing the context doesn't release it. So the media elements load with
`crossorigin="anonymous"` (set from JS, never in the HTML, so it stays
revocable), the main process forces `Access-Control-Allow-Origin: *` on the
loopback stream servers, and before the real elements are ever touched a
throwaway element is probed for signal. If any of that fails, `crossOrigin` is
dropped, the result is remembered, and playback continues without effects.
Modules are disabled by setting neutral parameters rather than rewiring: a
peaking biquad at 0 dB is exactly unity, so "off" is genuinely transparent.
Reverb is the one exception — a convolver runs regardless of its output gain, so
its input is disconnected.

**IPC.** `js/api.js` subscribes to each channel exactly once and fans out with
real unsubscribe functions. Nothing else may call `playerAPI.on*`: there's no
`removeListener` on the bridge, so a duplicate subscription can't be undone
without reloading the window — and `restore-magnets` adds a torrent per magnet,
so doubling it would add every saved torrent twice on launch.
