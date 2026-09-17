const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const releases = require('./binaries.json');

async function download(asset, destination) {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Checksum mismatch: ${asset.url}`);
  }
  await fs.writeFile(destination, bytes);
}

async function install() {
  const arch = process.env.BINARY_ARCH || process.arch;
  if (!releases[arch]) throw new Error(`Unsupported Linux architecture: ${arch}`);
  if (process.platform !== 'linux' && !process.env.BINARY_ARCH) {
    throw new Error('Run this build on Linux, or set BINARY_ARCH=x64/arm64 to download for inspection.');
  }
  const destination = path.resolve(__dirname, '../vendor/bin');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ytmp3-binaries-'));
  try {
    await fs.mkdir(destination, { recursive: true });
    await Promise.all([
      download(releases[arch].ytdlp, path.join(temporary, 'yt-dlp')),
      download(releases[arch].ffmpeg, path.join(temporary, 'ffmpeg.tar.xz')),
    ]);
    const entries = execFileSync('tar', ['-tf', path.join(temporary, 'ffmpeg.tar.xz')], { encoding: 'utf8' }).trim().split('\n');
    for (const name of ['ffmpeg', 'ffprobe']) {
      const entry = entries.find(item => item.endsWith(`/bin/${name}`));
      if (!entry || entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`Invalid archive entry for ${name}`);
      execFileSync('tar', ['-xf', path.join(temporary, 'ffmpeg.tar.xz'), '-C', temporary, entry]);
      await fs.copyFile(path.join(temporary, entry), path.join(destination, name));
    }
    await fs.copyFile(path.join(temporary, 'yt-dlp'), path.join(destination, 'yt-dlp'));
    for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
      const binary = path.join(destination, name);
      await fs.chmod(binary, 0o755);
      if (process.platform === 'linux' && process.arch === arch) {
        const version = execFileSync(binary, [name === 'yt-dlp' ? '--version' : '-version'], { encoding: 'utf8', timeout: 30000 });
        console.log(`${name}: ${version.split('\n')[0]}`);
      }
    }
    console.log(`Verified downloads and executable permissions for Linux ${arch}.`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

install().catch(error => { console.error(error.message); process.exitCode = 1; });
