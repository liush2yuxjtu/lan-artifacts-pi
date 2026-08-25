import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStorage, StorageError } from '../server/storage.mjs';

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lan-art-storage-'));
  const store = await createStorage({ dir, env: { LAN_ARTIFACT_MAX_VERSIONS: '3' } });
  return { dir, store };
}

test('create: 写 v1 文件与记录', async () => {
  const { dir, store } = await newStore();
  const a = await store.createArtifact({ html: '<h1>hi</h1>', title: 'T', emoji: '📊', sessionId: 's1' });
  assert.match(a.id, /^lan-art-[0-9a-f]{8}$/);
  assert.equal(a.versions.length, 1);
  assert.equal(a.versions[0].n, 1);
  assert.equal(a.versions[0].title, 'T');
  assert.equal(await readFile(join(dir, a.versions[0].htmlFile), 'utf8'), '<h1>hi</h1>');
});

test('append: n 递增，旧文件不动', async () => {
  const { dir, store } = await newStore();
  const a = await store.createArtifact({ html: 'v1' });
  const b = await store.appendVersion(a.id, { html: 'v2' });
  assert.equal(b.versions.length, 2);
  assert.equal(b.versions[1].n, 2);
  assert.equal(await readFile(join(dir, b.versions[0].htmlFile), 'utf8'), 'v1');
  assert.equal(await readFile(join(dir, b.versions[1].htmlFile), 'utf8'), 'v2');
  const got = await store.getHtml(a.id, '1');
  assert.equal(got.version, 1);
  assert.equal(got.html, 'v1');
});

test('不可变：追加后旧版本文件字节不变', async () => {
  const { dir, store } = await newStore();
  const a = await store.createArtifact({ html: 'immutable' });
  const first = a.versions[0].htmlFile;
  await store.appendVersion(a.id, { html: 'x2' });
  await store.appendVersion(a.id, { html: 'x3' });
  assert.equal(await readFile(join(dir, first), 'utf8'), 'immutable');
});

test('裁剪：最多保留 max versions，最旧文件从磁盘删除', async () => {
  const { dir, store } = await newStore();
  const a = await store.createArtifact({ html: 'v1' });
  for (let n = 2; n <= 5; n++) await store.appendVersion(a.id, { html: `v${n}` });
  const b = await store.getArtifact(a.id);
  assert.equal(b.versions.length, 3);
  assert.deepEqual(b.versions.map((v) => v.n), [3, 4, 5]);
  await assert.rejects(readFile(join(dir, 'html', a.id, 'v1.html')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'html', a.id, 'v2.html')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'html', a.id, 'v5.html'), 'utf8'), 'v5');
});

test('404：未知 id 与未知版本', async () => {
  const { store } = await newStore();
  await assert.rejects(store.getArtifact('nope'), (e) => e instanceof StorageError && e.code === 'NOT_FOUND' && e.status === 404);
  const a = await store.createArtifact({ html: 'x' });
  await assert.rejects(store.getHtml(a.id, '99'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  await assert.rejects(store.getHtml('nope'), (e) => e.code === 'NOT_FOUND');
});

test('TOO_LARGE：html 超过 16 MiB', async () => {
  const { store } = await newStore();
  const big = 'x'.repeat(16 * 1024 * 1024 + 1);
  await assert.rejects(store.createArtifact({ html: big }), (e) => e.code === 'TOO_LARGE' && e.status === 413);
  const a = await store.createArtifact({ html: 'ok' });
  await assert.rejects(store.appendVersion(a.id, { html: big }), (e) => e.code === 'TOO_LARGE');
});

test('delete：记录与磁盘文件都移除', async () => {
  const { dir, store } = await newStore();
  const a = await store.createArtifact({ html: 'x' });
  await store.deleteArtifact(a.id);
  await assert.rejects(store.getArtifact(a.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(readFile(join(dir, 'html', a.id, 'v1.html')));
});

test('持久化：重载 index.json 后数据仍在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lan-art-storage-'));
  await createStorage({ dir, env: {} }).then((s) => s.createArtifact({ html: 'x', title: 'P', emoji: '📊' }));
  const store2 = await createStorage({ dir, env: {} });
  const list = await store2.listArtifacts();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'P');
});
