const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');

function browser(fetch) {
  const elements = {};
  for (const id of ['url', 'quality', 'go', 'status', 'confirmBox', 'confirmText', 'confirmYes', 'confirmNo', 'activity', 'progress', 'progressDetail', 'cancelDownload']) {
    elements[id] = { value: 'https://youtu.be/abcdefghijk', style: {}, listeners: {}, removeAttribute(name) { delete this[name]; }, addEventListener(event, fn) { this.listeners[event] = fn; } };
  }
  elements.quality.value = 'fast';
  const links = [];
  const context = vm.createContext({ fetch, AbortController, TextDecoder, Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout() {},
    window: { addEventListener() {} },
    document: { getElementById: id => elements[id], body: { appendChild() {} }, createElement() { const link = { click() { links.push(this); }, remove() {} }; return link; } },
  });
  vm.runInContext(source, context);
  return { elements, links, start: () => vm.runInContext('startFlow()', context) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('repeated Enter cannot submit duplicate requests', async () => {
  let requests = 0;
  const ui = browser((url, { signal }) => { requests++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); });
  const first = ui.start();
  ui.elements.url.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await ui.start();
  assert.equal(requests, 1);
  assert.equal(ui.elements.go.disabled, true);
  ui.elements.cancelDownload.listeners.click();
  await first;
  assert.equal(ui.elements.status.textContent, 'Cancelled.');
  assert.equal(ui.elements.go.disabled, false);
});

test('live events update progress and conversion state before saving unicode filename', async () => {
  let stream;
  const ui = browser(async url => {
    if (url === '/api/info') return Response.json({ duration: 10 });
    if (url === '/api/download') return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    return new Response('mp3', { headers: { 'Content-Length': '3' } });
  });
  const flow = ui.start();
  await tick();
  const send = event => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  send({ type: 'progress', percent: 50, downloaded: 512, total: 1024, speed: 256, eta: 2 });
  await tick();
  assert.equal(ui.elements.progress.value, 50);
  assert.match(ui.elements.progressDetail.textContent, /50.0%.*256 B\/s.*2s remaining/);
  send({ type: 'stage', stage: 'converting', message: 'Converting audio to MP3…' });
  await tick();
  assert.match(ui.elements.status.textContent, /Converting/);
  assert.equal(ui.elements.progress.value, undefined);
  send({ type: 'progress', stage: 'converting', percent: 50, processed: 60, duration: 120, speed: 2, eta: 30 });
  await tick();
  assert.match(ui.elements.status.textContent, /Converting/);
  assert.equal(ui.elements.progress.value, 50);
  assert.match(ui.elements.progressDetail.textContent, /50.0%.*1:00 of 2:00 processed.*2.0× speed.*0:30 remaining/);
  send({ type: 'progress', stage: 'converting', percent: null, processed: 70, duration: null, speed: null, eta: null });
  await tick();
  assert.equal(ui.elements.progress.value, undefined);
  assert.equal(ui.elements.progressDetail.textContent, '1:10 processed');
  send({ type: 'ready', filename: 'தமிழ்.mp3', url: '/api/files/token' });
  stream.close();
  await flow;
  assert.equal(ui.links[0].download, 'தமிழ்.mp3');
  assert.equal(ui.elements.progress.value, 100);
  assert.equal(ui.elements.go.disabled, false);
});

test('long-video confirmation retains original URL and blocks duplicate flows', async () => {
  const requests = [];
  const ui = browser(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url === '/api/info') return Response.json({ title: 'Long', duration: 2000 });
    return new Response('{"type":"error","message":"Test stop"}\n');
  });
  ui.elements.quality.value = 'highest';
  const flow = ui.start();
  await tick();
  assert.equal(ui.elements.quality.disabled, true);
  assert.equal(ui.elements.confirmBox.style.display, 'block');
  ui.elements.url.value = 'https://youtu.be/changed';
  await ui.start();
  assert.equal(requests.length, 1);
  ui.elements.confirmYes.listeners.click();
  await flow;
  assert.equal(requests[1].body.url, 'https://youtu.be/abcdefghijk');
  assert.equal(requests[1].body.quality, 'highest');
  assert.equal(ui.elements.quality.disabled, false);
  assert.equal(ui.elements.status.textContent, 'Test stop');
});

test('truncated progress stream is not reported as success', async () => {
  const ui = browser(async url => url === '/api/info' ? Response.json({ duration: 10 }) : new Response('{"type":"heartbeat"}\n'));
  await ui.start();
  assert.match(ui.elements.status.textContent, /connection ended/);
  assert.equal(ui.links.length, 0);
});
