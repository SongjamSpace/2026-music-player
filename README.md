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

## Usage

1. Paste a magnet link into the text area (e.g. from a torrent site).
2. Click **Add torrent**. The torrent appears in the list and starts downloading.
3. Click a torrent to see its files, then click a file to play it. Audio and video are streamed as they download; no need to wait for the full file.
4. Downloads are saved to `~/Music/2026-Music-Player` by default. Added magnets are restored when you reopen the app.

## Tech

- **Electron** – desktop shell
- **WebTorrent** – torrent client and HTTP streaming server (range requests for seeking)
- **electron-store** – persist magnet URIs and download path
