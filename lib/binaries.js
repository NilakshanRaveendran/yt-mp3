const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function binaryConfig(env = process.env) {
  const directory = env.VERCEL ? path.resolve(__dirname, '../vendor/bin') : null;
  return {
    ytdlp: env.YTDLP_PATH || (directory ? path.join(directory, 'yt-dlp') : 'yt-dlp'),
    ffmpegDirectory: env.FFMPEG_DIR || directory,
  };
}

async function checkBinaries() {
  const config = binaryConfig();
  const entries = await Promise.all(['yt-dlp', 'ffmpeg', 'ffprobe'].map(async name => {
    const command = name === 'yt-dlp' ? config.ytdlp : config.ffmpegDirectory ? path.join(config.ffmpegDirectory, name) : name;
    try {
      const { stdout } = await execute(command, [name === 'yt-dlp' ? '--version' : '-version'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      return [name, { ok: true, version: stdout.trim().split('\n')[0] }];
    } catch (error) {
      return [name, { ok: false, code: String(error.code || 'START_FAILED') }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = { binaryConfig, checkBinaries };
