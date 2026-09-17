const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { binaryConfig } = require('../lib/binaries');

test('Vercel resolves bundled binaries independently of PATH', () => {
  const config = binaryConfig({ VERCEL: '1' });
  assert.equal(config.ytdlp, path.resolve(__dirname, '../vendor/bin/yt-dlp'));
  assert.equal(config.ffmpegDirectory, path.dirname(config.ytdlp));
});

test('local development keeps system commands and supports explicit overrides', () => {
  assert.deepEqual(binaryConfig({}), { ytdlp: 'yt-dlp', ffmpegDirectory: null });
  assert.deepEqual(binaryConfig({ VERCEL: '1', YTDLP_PATH: '/opt/yt-dlp', FFMPEG_DIR: '/opt/ffmpeg' }), {
    ytdlp: '/opt/yt-dlp', ffmpegDirectory: '/opt/ffmpeg',
  });
});
