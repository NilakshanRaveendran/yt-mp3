const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { binaryConfig, checkBinaries } = require('./lib/binaries');

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const INFO_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 45 * 60 * 1000;
const FILE_TTL_MS = 10 * 60 * 1000;
const MP3_PROFILES = {
  fast: { quality: '128K', encoderArgs: ' -compression_level 7' },
  highest: { quality: '0', encoderArgs: '' },
};

function isValidYoutubeUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || !YOUTUBE_HOSTS.has(parsed.hostname)) return false;
    if (parsed.hostname === 'youtu.be') return /^\/[\w-]+\/?$/.test(parsed.pathname);
    if (parsed.pathname === '/watch') return Boolean(parsed.searchParams.get('v'));
    return /^\/(live|shorts|embed)\/[\w-]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function timeoutForDuration(duration) {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, (Number(duration) || 0) * 500));
}

function stopProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
    } else {
      // Each job has its own group, including ffmpeg and other subprocesses.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (err) {
    if (err.code !== 'ESRCH') child.kill('SIGKILL');
  }
}

function runYtdlp(args, { signal, timeoutMs, onLine, capture = false, spawnProcess = spawn, killTree = stopProcessTree }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    const binaries = binaryConfig();
    const binaryArgs = binaries.ffmpegDirectory ? ['--ffmpeg-location', binaries.ffmpegDirectory, '--js-runtimes', `node:${process.execPath}`, ...args] : args;
    const child = spawnProcess(binaries.ytdlp, binaryArgs, {
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let failure;
    let output = '';
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(output);
    };
    const stop = (message) => {
      if (settled || failure) return;
      failure = new Error(message);
      killTree(child);
      // Wait for close before allowing the caller to remove files.
    };
    const abort = () => stop('Cancelled.');
    const timer = setTimeout(() => stop('The operation timed out. Please try again or choose a shorter video.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      const text = decoder.write(chunk);
      if (capture) {
        output += text;
        if (output.length > 16 * 1024 * 1024) stop('Video information is too large.');
      }
      if (onLine) {
        pending += text;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          onLine(pending.slice(0, newline).trim());
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 1024 * 1024) stop('Unexpected downloader output.');
      }
    });
    // Drain both pipes so verbose output cannot block the downloader.
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('yt-dlp is not installed or failed to start.')));
    child.once('close', (code) => {
      if (settled) return;
      const tail = decoder.end();
      if (capture) output += tail;
      if (onLine && (pending || tail)) onLine((pending + tail).trim());
      finish(failure || (code !== 0 ? new Error('Download failed. The video may be unavailable or restricted. Check that yt-dlp and ffmpeg are installed.') : null));
    });
  });
}

function parseProgress(line) {
  const prefix = 'download:';
  if (!line.startsWith(prefix)) return null;
  try {
    const progress = JSON.parse(line.slice(prefix.length));
    const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const downloaded = number(progress.downloaded_bytes);
    const total = number(progress.total_bytes) || number(progress.total_bytes_estimate);
    return {
      type: 'progress', stage: 'downloading', downloaded, total,
      estimated: !number(progress.total_bytes) && Boolean(total),
      percent: total && downloaded !== null ? Math.min(100, downloaded / total * 100) : null,
      speed: number(progress.speed), eta: number(progress.eta),
    };
  } catch {
    return null;
  }
}

function conversionProgress(fields, duration) {
  const processed = Number(fields.out_time_us);
  if (!Number.isFinite(processed) || processed < 0) return null;
  const seconds = processed / 1000000;
  const total = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;
  const rate = Number.parseFloat(fields.speed);
  const speed = Number.isFinite(rate) && rate > 0 ? rate : null;
  return {
    type: 'progress', stage: 'converting', processed: seconds, duration: total, speed,
    // Encoding can reach the duration before ffmpeg has finished writing the file.
    percent: total ? Math.min(99.9, seconds / total * 100) : null,
    eta: total && speed ? Math.max(0, (total - seconds) / speed) : null,
  };
}

function watchConversionProgress(filename, duration, onProgress) {
  let offset = 0;
  let pending = '';
  let fields = {};
  let reading;
  let failure;
  const read = async () => {
    let handle;
    try {
      handle = await fs.promises.open(filename, 'r');
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      pending += buffer.toString('utf8', 0, bytesRead);
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        const separator = line.indexOf('=');
        if (separator < 0) continue;
        const key = line.slice(0, separator);
        fields[key] = line.slice(separator + 1);
        if (key === 'progress') {
          const event = conversionProgress(fields, duration);
          if (event) onProgress(event);
          fields = {};
        }
      }
    } catch (err) {
      // The progress file appears only when the audio encoder starts.
      if (err.code !== 'ENOENT') failure = err;
    } finally {
      await handle?.close();
    }
  };
  const timer = setInterval(() => {
    if (!reading) reading = read().finally(() => { reading = null; });
  }, 500);
  return async () => {
    clearInterval(timer);
    await reading;
    await read();
    if (failure) throw failure;
  };
}

function createApp({ run = runYtdlp, infoTimeoutMs = INFO_TIMEOUT_MS, fileTtlMs = FILE_TTL_MS } = {}) {
  const app = express();
  const files = new Map();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  let binaryHealth;
  app.get('/api/health', async (req, res) => {
    binaryHealth ||= checkBinaries();
    const binaries = await binaryHealth;
    const ok = Object.values(binaries).every(binary => binary.ok);
    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ ok, binaries });
    if (!ok) binaryHealth = null;
  });

  const cleanup = (dir) => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  const requestSignal = (res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    return { signal: controller.signal, dispose: () => res.removeListener('close', disconnect) };
  };
  const validUrl = (req, res) => {
    const url = req.body?.url;
    if (typeof url === 'string' && isValidYoutubeUrl(url.trim())) return url.trim();
    res.status(400).json({ error: 'Please provide a valid YouTube video URL.' });
    return null;
  };
  const getVideoInfo = async (url, signal) => {
    const output = await run(['--ignore-config', '-j', '--no-playlist', '--no-warnings', url], {
      signal, timeoutMs: infoTimeoutMs, capture: true,
    });
    let info;
    try { info = JSON.parse(output); } catch { throw new Error('Could not read video information.'); }
    if (info.is_live || info.live_status === 'is_live') {
      throw new Error('This is an ongoing live stream and cannot be downloaded until it ends.');
    }
    return info;
  };

  app.post('/api/info', async (req, res) => {
    const url = validUrl(req, res);
    if (!url) return;
    const lifecycle = requestSignal(res);
    try {
      const info = await getVideoInfo(url, lifecycle.signal);
      if (!lifecycle.signal.aborted) res.json({ title: info.title, duration: info.duration || 0 });
    } catch (err) {
      if (!lifecycle.signal.aborted && !res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      lifecycle.dispose();
    }
  });

  app.post('/api/download', async (req, res) => {
    const url = validUrl(req, res);
    if (!url) return;
    const quality = req.body.quality ?? 'fast';
    if (typeof quality !== 'string' || !Object.hasOwn(MP3_PROFILES, quality)) {
      return res.status(400).json({ error: 'Please choose a valid MP3 quality option.' });
    }
    const profile = MP3_PROFILES[quality];
    const lifecycle = requestSignal(res);
    res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
    let outDir;
    try {
      send({ type: 'stage', stage: 'checking', message: 'Checking video…' });
      const info = await getVideoInfo(url, lifecycle.signal);
      if (lifecycle.signal.aborted) return;
      outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytmp3-'));
      send({ type: 'stage', stage: 'downloading', message: 'Starting audio download…' });
      const progressFile = path.join(outDir, 'conversion-progress.txt');
      let converting = false;
      const beginConversion = () => {
        if (converting) return;
        converting = true;
        send({ type: 'stage', stage: 'converting', message: 'Converting audio to MP3…' });
      };
      const stopWatching = watchConversionProgress(progressFile, info.duration, (event) => {
        beginConversion();
        send(event);
      });
      try {
        await run([
          '--ignore-config', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', profile.quality,
          '--no-playlist', '--newline', '--progress', '--no-colors', '--progress-delta', '0.5',
          '--progress-template', 'download:download:%(progress)j',
          '--progress-template', 'postprocess:postprocess:%(progress.status)s',
          '--postprocessor-args', `ExtractAudio+ffmpeg_o:-progress '${progressFile.replace(/'/g, "'\\''")}' -stats_period 0.5${profile.encoderArgs}`,
          '-o', path.join(outDir, '%(title).180B.%(ext)s'), url,
        ], {
          signal: lifecycle.signal, timeoutMs: timeoutForDuration(info.duration),
          onLine(line) {
            const progress = parseProgress(line);
            if (progress) send(progress);
            else if (line === 'postprocess:started') beginConversion();
          },
        });
      } finally {
        await stopWatching();
      }
      if (lifecycle.signal.aborted) return;
      const names = await fs.promises.readdir(outDir);
      const filename = names.find((name) => name.endsWith('.mp3'));
      if (!filename) throw new Error('No MP3 file was produced.');
      if (lifecycle.signal.aborted) return;
      const token = crypto.randomBytes(24).toString('hex');
      const directory = outDir;
      const timer = setTimeout(() => {
        files.delete(token);
        cleanup(directory);
      }, fileTtlMs);
      timer.unref();
      files.set(token, { directory, filename, timer });
      outDir = null; // The file endpoint or expiry timer now owns cleanup.
      send({ type: 'ready', filename, url: `/api/files/${token}` });
    } catch (err) {
      if (!lifecycle.signal.aborted) send({ type: 'error', message: err.message });
    } finally {
      clearInterval(heartbeat);
      lifecycle.dispose();
      if (outDir) await cleanup(outDir);
      if (!res.destroyed) res.end();
    }
  });

  app.get('/api/files/:token', (req, res) => {
    const file = files.get(req.params.token);
    if (!file) return res.status(404).json({ error: 'This download has expired. Please download the audio again.' });
    files.delete(req.params.token);
    clearTimeout(file.timer);
    res.download(path.join(file.directory, file.filename), file.filename, (err) => {
      cleanup(file.directory);
      if (err && !res.headersSent && !res.destroyed) res.status(500).json({ error: 'Could not send the MP3 file.' });
    });
  });
  return app;
}

const app = createApp();

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`YT to MP3 running at http://localhost:${PORT}`));
}

// Vercel imports the request handler without starting a local HTTP listener.
module.exports = app;
Object.assign(module.exports, { createApp, runYtdlp, parseProgress, isValidYoutubeUrl, stopProcessTree, conversionProgress });
