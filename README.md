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

## Vercel deployment

Import the repository root with the Express framework preset. `vercel.json` runs
`npm run build:vercel` to download pinned, SHA-256-verified Linux yt-dlp, ffmpeg,
and ffprobe releases into `vendor/bin/`, marks them executable, and includes them
in the function. The build selects x64 or arm64 from the build machine and runs
version checks on Linux. Do not set the root directory to `public` for this setup.

The server uses absolute bundled paths on Vercel, supplies `--ffmpeg-location`,
and enables the Node.js runtime for yt-dlp. Local development uses system tools;
`YTDLP_PATH` and `FFMPEG_DIR` optionally override their locations.

After deployment, visit `/api/health`. HTTP 200 with `ok: true` and versions for
all three tools confirms they execute inside the deployed function. This checks
binary availability, not YouTube access or end-to-end conversion.

Release URLs and checksums live in `scripts/binaries.json`. Update both together
when upgrading. Binaries are downloaded during builds, not committed to Git.
On macOS, `BINARY_ARCH=x64 npm run build:vercel` downloads Linux binaries for
inspection without trying to execute them.

Vercel execution limits still apply. File tokens and temporary MP3s are local to
each instance, so subsequent file requests are not guaranteed to find them when
the app scales. Reliable multi-instance downloads require shared job storage
and object storage, or a separate persistent conversion backend.

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
