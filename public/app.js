const urlInput = document.getElementById('url');
const qualityInput = document.getElementById('quality');
const btn = document.getElementById('go');
const status = document.getElementById('status');
const confirmBox = document.getElementById('confirmBox');
const confirmText = document.getElementById('confirmText');
const confirmYes = document.getElementById('confirmYes');
const confirmNo = document.getElementById('confirmNo');
const activity = document.getElementById('activity');
const progress = document.getElementById('progress');
const progressDetail = document.getElementById('progressDetail');
const cancelDownload = document.getElementById('cancelDownload');
let busy = false;
let controller;
let confirmChoice;

function setStatus(className, text) {
  status.className = className;
  status.textContent = text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function updateProgress(event) {
  if (event.stage === 'converting') {
    setStatus('', 'Converting audio to MP3…');
    if (event.percent === null) progress.removeAttribute('value');
    else progress.value = event.percent;
    const parts = [];
    if (event.percent !== null) parts.push(`${event.percent.toFixed(1)}%`);
    parts.push(`${formatTime(event.processed)}${event.duration ? ` of ${formatTime(event.duration)}` : ''} processed`);
    if (event.speed) parts.push(`${event.speed.toFixed(1)}× speed`);
    if (event.eta !== null) parts.push(`About ${formatTime(Math.ceil(event.eta))} remaining`);
    progressDetail.textContent = parts.join(' · ');
    return;
  }
  setStatus('', 'Downloading audio…');
  if (event.percent === null) progress.removeAttribute('value');
  else progress.value = event.percent;
  const parts = [];
  if (event.percent !== null) parts.push(`${event.estimated ? 'About ' : ''}${event.percent.toFixed(1)}%`);
  if (event.downloaded !== null) parts.push(`${formatBytes(event.downloaded)}${event.total ? ` of ${event.estimated ? '~' : ''}${formatBytes(event.total)}` : ''}`);
  if (event.speed) parts.push(`${formatBytes(event.speed)}/s`);
  if (event.eta !== null) parts.push(`${Math.ceil(event.eta)}s remaining`);
  progressDetail.textContent = parts.join(' · ') || 'Waiting for download size…';
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function saveFile(file, signal) {
  setStatus('', 'Receiving MP3 file…');
  progress.removeAttribute('value');
  progressDetail.textContent = '';
  const response = await fetch(file.url, { signal });
  if (!response.ok) throw new Error('Could not receive the MP3 file. Please try again.');
  const total = Number(response.headers.get('Content-Length')) || null;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) progress.value = Math.min(100, received / total * 100);
      progressDetail.textContent = `${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''} received`;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  progress.value = 100;
  setStatus('ok', 'Done! Check your downloads.');
}

async function startFlow() {
  if (busy) return;
  const url = urlInput.value.trim();
  const quality = qualityInput.value;
  if (!url) { setStatus('error', 'Please enter a URL.'); return; }
  busy = true;
  btn.disabled = true;
  urlInput.disabled = true;
  qualityInput.disabled = true;
  controller = new AbortController();
  const { signal } = controller;
  activity.hidden = false;
  cancelDownload.hidden = false;
  progress.removeAttribute('value');
  progressDetail.textContent = '';
  setStatus('', 'Checking video…');
  try {
    const infoResponse = await fetch('/api/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }), signal,
    });
    const info = await infoResponse.json();
    if (!infoResponse.ok) throw new Error(info.error || 'Could not check this video.');
    signal.throwIfAborted();
    if (info.duration > 20 * 60) {
      const minutes = Math.ceil(info.duration / 60);
      setStatus('warn', `“${info.title}” is ${minutes} minutes long.`);
      confirmText.textContent = 'Downloading and converting this video could take a while. Continue?';
      confirmBox.style.display = 'block';
      activity.hidden = true;
      const accepted = await new Promise((resolve) => { confirmChoice = resolve; });
      confirmChoice = null;
      confirmBox.style.display = 'none';
      signal.throwIfAborted();
      if (!accepted) { setStatus('', 'Cancelled.'); return; }
      activity.hidden = false;
    }
    const response = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality }), signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Download failed.');
    }
    let file;
    await readEvents(response, (event) => {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'progress') updateProgress(event);
      if (event.type === 'stage') {
        setStatus('', event.message);
        progress.removeAttribute('value');
        progressDetail.textContent = event.stage === 'converting' ? 'Audio downloaded. Preparing your MP3…' : '';
      }
      if (event.type === 'ready') file = event;
    });
    if (!file) throw new Error('The connection ended before the download finished. Please try again.');
    await saveFile(file, signal);
  } catch (err) {
    controller.abort();
    activity.hidden = true;
    setStatus(err.name === 'AbortError' ? '' : 'error', err.name === 'AbortError' ? 'Cancelled.' : err.message || 'Something went wrong.');
  } finally {
    confirmChoice = null;
    confirmBox.style.display = 'none';
    cancelDownload.hidden = true;
    busy = false;
    controller = null;
    btn.disabled = false;
    urlInput.disabled = false;
    qualityInput.disabled = false;
  }
}

confirmYes.addEventListener('click', () => confirmChoice?.(true));
confirmNo.addEventListener('click', () => confirmChoice?.(false));
cancelDownload.addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => { controller?.abort(); confirmChoice?.(false); });
btn.addEventListener('click', startFlow);
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); startFlow(); }
});
