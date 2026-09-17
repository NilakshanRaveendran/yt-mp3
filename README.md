# YouTube to MP3

A small local Express app that downloads YouTube audio and converts it to MP3.

## Run

Install Node.js 18 or newer, `yt-dlp`, and `ffmpeg`. Both executables must be on your PATH.

```sh
npm install
npm start
```

Open http://localhost:3000. Set `PORT` to use a different port.

The page shows download percentage, downloaded bytes, speed, and estimated time remaining when the source provides them. MP3 conversion shows actual processed audio time, percentage, encoding speed, and estimated time remaining, updated about twice per second. Unknown durations show processed time without inventing a percentage. A separate transfer stage shows the MP3 being received by the browser.

Fast mode (the default) uses 128 kbps MP3 with a faster encoder setting, trading some audio detail for shorter conversion time and smaller files. Highest quality retains the previous quality-0 encoding. Mode changes apply to new downloads; an active conversion keeps its original settings.

Cancel download or close the page to stop active work. Metadata checks time out after one minute; downloads time out after 5–45 minutes depending on the video duration. Completed files that are not retrieved expire after ten minutes.

## Tests

```sh
npm test
```

Tests cover streamed progress, file transfer and expiry, process failures, timeouts, cancellation and cleanup, and browser submission guards. HTTP tests use temporary localhost ports and simulated downloads; no YouTube access is needed.

## API

- `POST /api/info` with `{ "url": "..." }` returns title and duration.
- `POST /api/download` with `{ "url": "...", "quality": "fast" }` (or `"highest"`; defaults to `"fast"`) returns newline-delimited JSON events: `stage`, `progress`, `heartbeat`, `error`, and `ready`. Errors after streaming starts are events, even though HTTP status is 200.
- The `ready` event includes a filename and one-use `/api/files/:token` URL for retrieving the completed MP3.

Use with content you have the rights to download.
