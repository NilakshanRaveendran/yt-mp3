const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApp, runYtdlp, parseProgress, isValidYoutubeUrl } = require('../server');

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
}

async function serve(t, options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const payload = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk' }) };

// These reproduce the review's process lifecycle failures without network downloads.
test('spawn error followed by close rejects once without crashing', async () => {
  const proc = child();
  const result = runYtdlp([], { timeoutMs: 1000, spawnProcess: () => proc });
  proc.emit('error', new Error('ENOENT'));
  assert.doesNotThrow(() => proc.emit('close', -2));
  await assert.rejects(result, /failed to start/);
});

test('metadata timeout kills the process and waits for close', async () => {
  const proc = child();
  let killed = false;
  const result = runYtdlp([], { timeoutMs: 10, capture: true, spawnProcess: () => proc,
    killTree(p) { assert.equal(p, proc); killed = true; setImmediate(() => p.emit('close', null)); } });
  await assert.rejects(result, /timed out/);
  assert.equal(killed, true);
});

test('abort cancels child process and consumes both output pipes', async () => {
  const proc = child();
  const controller = new AbortController();
  let killed = 0;
  const result = runYtdlp([], { signal: controller.signal, timeoutMs: 1000, spawnProcess: () => proc,
    killTree(p) { killed++; p.emit('close', null); } });
  assert.ok(proc.stdout.listenerCount('data'));
  assert.ok(proc.stderr.listenerCount('data'));
  controller.abort();
  await assert.rejects(result, /Cancelled/);
  assert.equal(killed, 1);
});

test('progress handles split output, unknown totals, and estimated totals', async () => {
  const proc = child();
  const events = [];
  const result = runYtdlp([], { timeoutMs: 1000, spawnProcess: () => proc, onLine: line => events.push(parseProgress(line)) });
  proc.stdout.write('download:{"downloaded_bytes":50,');
  proc.stdout.write('"total_bytes":100,"speed":10,"eta":5}\n');
  proc.emit('close', 0);
  await result;
  assert.equal(events[0].percent, 50);
  assert.equal(events[0].speed, 10);
  assert.equal(parseProgress('download:{"downloaded_bytes":50}').percent, null);
  assert.equal(parseProgress('download:{"downloaded_bytes":50,"total_bytes_estimate":200}').estimated, true);
  assert.equal(parseProgress('download:not-json'), null);
});

test('download streams progress before completion and serves an MP3 once', async t => {
  let release;
  let directory;
  const base = await serve(t, { run: async (args, options) => {
    if (args.includes('-j')) return JSON.stringify({ title: 'Test', duration: 10 });
    directory = path.dirname(args[args.indexOf('-o') + 1]);
    options.onLine('download:{"downloaded_bytes":50,"total_bytes":100,"speed":25,"eta":2}');
    await new Promise(resolve => { release = resolve; });
    options.onLine('postprocess:started');
    await fs.writeFile(path.join(directory, 'Test.mp3'), 'fake mp3');
  } });
  const response = await fetch(`${base}/api/download`, payload);
  const reader = response.body.getReader();
  let body = '';
  while (!body.includes('"percent":50')) body += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!body.includes('"ready"'));
  release();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value); }
  const events = body.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.stage === 'converting'));
  const file = events.find(event => event.type === 'ready');
  assert.ok(file);
  const download = await fetch(base + file.url);
  assert.match(download.headers.get('content-disposition'), /Test.mp3/);
  assert.equal(await download.text(), 'fake mp3');
  assert.equal((await fetch(base + file.url)).status, 404);
  // rm is asynchronous after the file response completes.
  for (let i = 0; i < 30; i++) {
    try { await fs.stat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Temporary directory was not removed');
});

test('disconnect during metadata lookup aborts the running job', async t => {
  let aborted;
  const cancellation = new Promise(resolve => { aborted = resolve; });
  const base = await serve(t, { run: (args, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted(); reject(new Error('Cancelled.')); }, { once: true });
  }) });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/download`, { ...payload, signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await cancellation;
});

test('failed conversion is a stream error with no ready file', async t => {
  const base = await serve(t, { run: async args => {
    if (args.includes('-j')) return '{"duration":10}';
    throw new Error('Conversion failed');
  } });
  const response = await fetch(`${base}/api/download`, payload);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).message, 'Conversion failed');
  assert.ok(!events.some(event => event.type === 'ready'));
});

test('unclaimed files expire', async t => {
  let directory;
  const base = await serve(t, { fileTtlMs: 20, run: async args => {
    if (args.includes('-j')) return '{"duration":10}';
    directory = path.dirname(args[args.indexOf('-o') + 1]);
    await fs.writeFile(path.join(directory, 'Test.mp3'), 'fake');
  } });
  const response = await fetch(`${base}/api/download`, payload);
  const file = (await response.text()).trim().split('\n').map(JSON.parse).find(event => event.type === 'ready');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await fetch(base + file.url)).status, 404);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('rejects invalid protocols and empty video IDs', () => {
  assert.equal(isValidYoutubeUrl('ftp://youtube.com/watch?v=abc'), false);
  assert.equal(isValidYoutubeUrl('https://youtube.com/watch?v='), false);
  assert.equal(isValidYoutubeUrl('https://example.com/watch?v=abc'), false);
  assert.equal(isValidYoutubeUrl('https://youtu.be/abcdefghijk'), true);
});

test('disconnect during download aborts conversion and cleans temporary files', async t => {
  let directory;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let notifyAborted;
  const aborted = new Promise(resolve => { notifyAborted = resolve; });
  const base = await serve(t, { run: async (args, { signal }) => {
    if (args.includes('-j')) return '{"duration":10}';
    directory = path.dirname(args[args.indexOf('-o') + 1]);
    await fs.writeFile(path.join(directory, 'partial.webm'), 'partial');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { notifyAborted(); reject(new Error('Cancelled.')); }, { once: true });
      notifyStarted();
    });
  } });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/download`, { ...payload, signal: controller.signal });
  await response.body.getReader().read();
  await started;
  controller.abort();
  await aborted;
  for (let i = 0; i < 30; i++) {
    try { await fs.stat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Cancelled job left temporary files');
});

test('POSIX cancellation terminates subprocesses in the job group', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const { spawn } = require('node:child_process');
  const { stopProcessTree } = require('../server');
  const proc = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopProcessTree(proc));
  const closed = new Promise(resolve => proc.once('close', (code, signal) => resolve(signal)));
  await new Promise(resolve => proc.stdout.once('data', resolve));
  stopProcessTree(proc);
  // close waits for inherited pipes: it cannot fire while the descendant holds them.
  assert.equal(await closed, 'SIGKILL');
});

test('conversion math handles missing duration, startup values and finalization', () => {
  const { conversionProgress } = require('../server');
  assert.equal(conversionProgress({ out_time_us: 'N/A' }, 100), null);
  const half = conversionProgress({ out_time_us: '50000000', speed: '2.0x' }, 100);
  assert.equal(half.percent, 50);
  assert.equal(half.processed, 50);
  assert.equal(half.eta, 25);
  const unknown = conversionProgress({ out_time_us: '50000000', speed: 'N/A' }, null);
  assert.equal(unknown.percent, null);
  assert.equal(unknown.eta, null);
  assert.equal(unknown.processed, 50);
  assert.equal(conversionProgress({ out_time_us: '100000000', speed: '2x' }, 100).percent, 99.9);
});

test('conversion progress reaches the client while encoding is still running', { timeout: 5000 }, async t => {
  let release;
  const base = await serve(t, { run: async (args, options) => {
    if (args.includes('-j')) return '{"title":"Test","duration":100}';
    const directory = path.dirname(args[args.indexOf('-o') + 1]);
    assert.ok(args[args.indexOf('--postprocessor-args') + 1].includes('conversion-progress.txt'));
    options.onLine('postprocess:started');
    await fs.writeFile(path.join(directory, 'conversion-progress.txt'), 'out_time_us=50000000\nspeed=2.0x\nprogress=continue\n');
    await new Promise(resolve => { release = resolve; });
    options.onLine('postprocess:finished');
    await fs.appendFile(path.join(directory, 'conversion-progress.txt'), 'out_time_us=100000000\nspeed=2.0x\nprogress=end\n');
    await fs.writeFile(path.join(directory, 'Test.mp3'), 'fake');
  } });
  const response = await fetch(`${base}/api/download`, payload);
  const reader = response.body.getReader();
  let body = '';
  while (!body.includes('"processed":50')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
  }
  assert.ok(!body.includes('"ready"'));
  release();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value); }
  const events = body.trim().split('\n').map(JSON.parse);
  const conversion = events.filter(event => event.type === 'progress' && event.stage === 'converting');
  assert.equal(conversion[0].percent, 50);
  assert.equal(conversion[0].eta, 25);
  assert.equal(conversion.at(-1).processed, 100);
  assert.equal(events.filter(event => event.type === 'stage' && event.stage === 'converting').length, 1);
  const file = events.find(event => event.type === 'ready');
  await (await fetch(base + file.url)).arrayBuffer();
});

for (const quality of [undefined, 'fast', 'highest']) {
  test(`MP3 profile ${quality ?? 'default'} selects encoding settings and preserves progress`, async t => {
    let downloadArgs;
    const base = await serve(t, { run: async args => {
      if (args.includes('-j')) return '{"duration":100}';
      downloadArgs = args;
      throw new Error('Stop after checking arguments');
    } });
    const response = await fetch(`${base}/api/download`, { ...payload, body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk', quality }) });
    await response.text();
    assert.ok(downloadArgs);
    assert.equal(downloadArgs[downloadArgs.indexOf('--audio-quality') + 1], quality === 'highest' ? '0' : '128K');
    const encoderArgs = downloadArgs[downloadArgs.indexOf('--postprocessor-args') + 1];
    assert.match(encoderArgs, /-progress .*conversion-progress.txt.*-stats_period 0.5/);
    assert.equal(encoderArgs.includes('-compression_level 7'), quality !== 'highest');
  });
}

test('invalid quality cannot inject encoder arguments or start work', async t => {
  const base = await serve(t, { run: async () => assert.fail('Invalid mode started a process') });
  for (const quality of ['-compression_level 0', 'toString', {}, 7]) {
    const response = await fetch(`${base}/api/download`, { ...payload, body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk', quality }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /quality/);
  }
});
