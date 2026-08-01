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

### Keyboard

`Space` play/pause · `←`/`→` seek ±10s (`⇧` for ±30s) · `⌘←`/`⌘→` prev/next ·
`⌘↑`/`⌘↓` volume · `M` mute · `S` shuffle · `R` repeat · `⌘F` filter tracks ·
`⌘,` settings · `F` fullscreen video · `⌘⌥T` cycle theme · `?` full list.

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
    namespace.js util.js icons.js theme.js
    store.js              topic-scoped state
    api.js                the ONLY caller of playerAPI.on*
    actions.js player.js main.js
    ui/  sidebar.js torrent-header.js tracklist.js transport.js
         dialogs.js toast.js menu.js empty.js shortcuts.js
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

**IPC.** `js/api.js` subscribes to each channel exactly once and fans out with
real unsubscribe functions. Nothing else may call `playerAPI.on*`: there's no
`removeListener` on the bridge, so a duplicate subscription can't be undone
without reloading the window — and `restore-magnets` adds a torrent per magnet,
so doubling it would add every saved torrent twice on launch.
