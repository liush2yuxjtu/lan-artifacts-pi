import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLanServer } from '../server/lan-server.mjs';
import { createStorage } from '../server/storage.mjs';

const TOKEN = 'test-write-token';
let base;
let server;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lan-art-api-'));
  const env = { LAN_ARTIFACT_WRITE_TOKEN: TOKEN, LAN_ARTIFACT_MAX_VERSIONS: '5' };
  const storage = await createStorage({ dir, env });
  server = createLanServer({ storage, env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function authHeaders(overrides = {}) {
  return { 'content-type': 'application/json', 'x-artifact-write-token': TOKEN, ...overrides };
}

test('health', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, '0.1.0');
  assert.equal(body.artifactCount, 0);
  assert.match(res.headers.get('cache-control'), /no-store/);
});

let artifactId;

test('创建需要写令牌：401 无令牌/错令牌，201 正确令牌', async () => {
  const noAuth = await fetch(`${base}/api/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: '<h1>hi</h1>' }),
  });
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).error.code, 'UNAUTHORIZED');

  const bad = await fetch(`${base}/api/artifacts`, {
    method: 'POST',
    headers: authHeaders({ 'x-artifact-write-token': 'wrong' }),
    body: JSON.stringify({ html: '<h1>hi</h1>' }),
  });
  assert.equal(bad.status, 401);

  const res = await fetch(`${base}/api/artifacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ html: '<h1>v1</h1>', title: 'T1', emoji: '📊', sessionId: 's1' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.id, /^lan-art-[0-9a-f]{8}$/);
  assert.equal(body.version, 1);
  assert.equal(body.title, 'T1');
  assert.equal(body.emoji, '📊');
  assert.equal(body.url, `${base}/v/${body.id}`);
  artifactId = body.id;
});

test('追加版本 + 按版本取 html', async () => {
  const res = await fetch(`${base}/api/artifacts/${artifactId}/versions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ html: '<h1>v2</h1>' }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).version, 2);

  const latest = await fetch(`${base}/api/artifacts/${artifactId}/html`);
  assert.equal(latest.status, 200);
  assert.match(latest.headers.get('content-type'), /text\/html/);
  assert.equal(await latest.text(), '<h1>v2</h1>');

  const v1 = await fetch(`${base}/api/artifacts/${artifactId}/html?version=1`);
  assert.equal(await v1.text(), '<h1>v1</h1>');

  const v99 = await fetch(`${base}/api/artifacts/${artifactId}/html?version=99`);
  assert.equal(v99.status, 404);
  const bad = await fetch(`${base}/api/artifacts/${artifactId}/html?version=abc`);
  assert.equal(bad.status, 400);
});

test('列表与元数据', async () => {
  const list = await (await fetch(`${base}/api/artifacts`)).json();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['emoji', 'id', 'sessionId', 'title', 'updatedAt', 'url', 'versionCount']);
  assert.equal(list[0].versionCount, 2);
  assert.equal(list[0].url, `${base}/v/${artifactId}`);

  const meta = await (await fetch(`${base}/api/artifacts/${artifactId}`)).json();
  assert.equal(meta.versions.length, 2);
  assert.equal(meta.versions[1].n, 2);
  assert.equal(meta.versionCount, 2);
});

test('SSE：发布新版本后收到 version 事件', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/artifacts/${artifactId}/events`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const publish = await fetch(`${base}/api/artifacts/${artifactId}/versions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ html: '<h1>v3</h1>' }),
  });
  assert.equal(publish.status, 201);
  assert.equal((await publish.json()).version, 3);

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const frame of buf.split('\n\n')) {
        if (!frame.startsWith('event: version')) continue;
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(6));
        if (data.version === 3) return; // 收到目标事件
      }
      buf = buf.slice(-8192);
    }
    throw new Error('未收到 version 事件');
  } finally {
    ac.abort();
  }
});

test('viewer shell 与 viewer.js；DELETE 需令牌后 204', async () => {
  const shell = await fetch(`${base}/v/${artifactId}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type'), /text\/html/);
  const html = await shell.text();
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /version-picker/);

  const js = await fetch(`${base}/viewer.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const noAuth = await fetch(`${base}/api/artifacts/${artifactId}`, { method: 'DELETE' });
  assert.equal(noAuth.status, 401);

  const del = await fetch(`${base}/api/artifacts/${artifactId}`, { method: 'DELETE', headers: { 'x-artifact-write-token': TOKEN } });
  assert.equal(del.status, 204);

  const gone = await fetch(`${base}/api/artifacts/${artifactId}`);
  assert.equal(gone.status, 404);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.artifactCount, 0);
});
