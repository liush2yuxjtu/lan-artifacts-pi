// 查看器逻辑：拉取版本 html、SSE 订阅、版本切换（固定/跟随 latest）。
const frame = document.getElementById('frame');
const select = document.getElementById('version-picker');
const titleEl = document.getElementById('title');
const aidEl = document.getElementById('artifact-id');
const rawLink = document.getElementById('raw-link');
const liveEl = document.getElementById('live');
const liveLabel = document.getElementById('live-label');
const flashEl = document.getElementById('flash');
const emptyEl = document.getElementById('empty');
const emptyMsg = document.getElementById('empty-msg');
const pinnedEl = document.getElementById('pinned');
const favicon = document.querySelector('link[rel="icon"]');

const id = location.pathname.split('/')[2];
let latestVersion = 0;
let pinned = 'latest';

function setFavicon(emoji) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`;
  favicon.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function showEmpty(msg) {
  document.body.classList.add('notfound');
  frame.hidden = true;
  emptyMsg.textContent = msg || 'Artifact not found';
  emptyEl.hidden = false;
}

function setLive(on) {
  liveEl.classList.toggle('off', !on);
  liveLabel.textContent = on ? 'Live' : '离线';
}

function addVersionOption(n) {
  if (document.querySelector(`#version-picker option[value="v${n}"]`)) return;
  const opt = document.createElement('option');
  opt.value = `v${n}`;
  opt.textContent = `v${n}`;
  select.appendChild(opt);
}

function markPinned() {
  pinnedEl.textContent = pinned === 'latest' ? '' : `已固定 ${pinned}`;
  pinnedEl.hidden = pinned === 'latest';
}

async function loadVersion(v) {
  const url = `/api/artifacts/${id}/html` + (v === 'latest' ? '' : `?version=${v}`);
  const res = await fetch(url);
  if (!res.ok) {
    showEmpty('加载失败');
    return;
  }
  frame.srcdoc = await res.text();
  frame.hidden = false;
  emptyEl.hidden = true;
}

function flash() {
  flashEl.hidden = false;
  clearTimeout(flashEl._t);
  flashEl._t = setTimeout(() => { flashEl.hidden = true; }, 1800);
}

async function init() {
  const res = await fetch(`/api/artifacts/${id}`);
  if (!res.ok) {
    showEmpty();
    return;
  }
  const meta = await res.json();
  document.title = `${meta.emoji} ${meta.title}`;
  setFavicon(meta.emoji);
  titleEl.textContent = meta.title;
  aidEl.textContent = meta.id;
  rawLink.href = `/api/artifacts/${id}/html`;
  latestVersion = meta.versions.length;
  for (let n = 1; n <= latestVersion; n++) addVersionOption(n);
  await loadVersion(pinned);

  const es = new EventSource(`/api/artifacts/${id}/events`);
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.addEventListener('version', (e) => {
    const data = JSON.parse(e.data);
    if (data.version <= latestVersion) return; // 忽略加载时收到的历史事件
    addVersionOption(data.version);
    latestVersion = data.version;
    if (pinned === 'latest') loadVersion('latest').then(flash);
  });
}

select.addEventListener('change', () => {
  pinned = select.value;
  markPinned();
  loadVersion(pinned);
});

if (!id) showEmpty();
else init().catch(showEmpty);
