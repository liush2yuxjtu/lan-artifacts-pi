// 文件型存储：内存索引 + 磁盘版本文件，原子写（tmp+rename），版本不可变，保留期裁剪。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export class StorageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.message = message;
    this.status = status;
  }
}

const MAX_HTML_BYTES = 16 * 1024 * 1024; // 16 MiB 上限（契约）
const ID_PREFIX = 'lan-art-';

function assertHtml(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new StorageError('BAD_REQUEST', 'html 必须是非空字符串。', 400);
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new StorageError('TOO_LARGE', 'html 超过 16 MiB 上限。', 413);
  }
}

export async function createStorage({ dir, env = process.env }) {
  const maxVersions = Math.max(1, Number.parseInt(env.LAN_ARTIFACT_MAX_VERSIONS || '50', 10));
  const htmlRoot = join(dir, 'html');
  const indexFile = join(dir, 'index.json');
  await mkdir(htmlRoot, { recursive: true });

  let index;
  try {
    index = JSON.parse(await readFile(indexFile, 'utf8'));
  } catch {
    index = { artifacts: [] };
  }
  if (!Array.isArray(index.artifacts)) index.artifacts = [];

  // ponytail: single-process assumption, per-artifact locks if multi-process
  async function saveIndex() {
    const tmp = `${indexFile}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, indexFile);
  }

  async function writeHtml(id, n, html) {
    const file = join(htmlRoot, id, `v${n}.html`);
    await mkdir(join(htmlRoot, id), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, html, 'utf8');
    await rename(tmp, file); // 原子替换；v{n}.html 一旦落盘永不被覆盖
    return `html/${id}/v${n}.html`;
  }

  function findOrThrow(id) {
    const artifact = index.artifacts.find((a) => a.id === id);
    if (!artifact) throw new StorageError('NOT_FOUND', `Artifact ${id} 不存在。`, 404);
    return artifact;
  }

  return {
    maxVersions,

    listArtifacts() {
      return [...index.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getArtifact(id) {
      return findOrThrow(id);
    },

    async getHtml(id, version) {
      const artifact = findOrThrow(id);
      let v;
      if (version === undefined || version === null || version === '') {
        v = artifact.versions[artifact.versions.length - 1];
      } else {
        const n = Number.parseInt(String(version), 10);
        if (!Number.isInteger(n) || n < 1) {
          throw new StorageError('BAD_REQUEST', 'version 必须是正整数。', 400);
        }
        v = artifact.versions.find((x) => x.n === n);
        if (!v) throw new StorageError('NOT_FOUND', `版本 ${n} 不存在。`, 404);
      }
      try {
        return { html: await readFile(join(dir, v.htmlFile), 'utf8'), version: v.n };
      } catch {
        throw new StorageError('INTERNAL', '版本文件读取失败。', 500);
      }
    },

    async createArtifact({ html, title, emoji, sessionId, summary }) {
      assertHtml(html);
      const id = `${ID_PREFIX}${randomBytes(4).toString('hex')}`;
      const now = new Date().toISOString();
      const t = title || 'Untitled artifact';
      const artifact = {
        id,
        title: t,
        emoji: emoji || '📄',
        sessionId: sessionId || null,
        createdAt: now,
        updatedAt: now,
        versions: [],
      };
      artifact.versions.push({
        n: 1,
        title: t,
        summary: summary || '',
        htmlFile: await writeHtml(id, 1, html),
        createdAt: now,
        bytes: Buffer.byteLength(html, 'utf8'),
      });
      index.artifacts.push(artifact);
      await saveIndex();
      return artifact;
    },

    async appendVersion(id, { html, title, summary }) {
      assertHtml(html);
      const artifact = findOrThrow(id);
      const now = new Date().toISOString();
      const prev = artifact.versions[artifact.versions.length - 1];
      // 版本号必须单调递增：用最大 n+1，而非数组长度（裁剪后长度会变小）
      const n = Math.max(0, ...artifact.versions.map((v) => v.n)) + 1;
      artifact.versions.push({
        n,
        title: title || prev.title,
        summary: summary || '',
        htmlFile: await writeHtml(id, n, html),
        createdAt: now,
        bytes: Buffer.byteLength(html, 'utf8'),
      });
      artifact.updatedAt = now;
      // 保留期：裁剪最旧版本（磁盘文件 + 索引）
      while (artifact.versions.length > maxVersions) {
        const old = artifact.versions.shift();
        await rm(join(dir, old.htmlFile), { force: true });
      }
      await saveIndex();
      return artifact;
    },

    async deleteArtifact(id) {
      findOrThrow(id);
      index.artifacts = index.artifacts.filter((a) => a.id !== id);
      await rm(join(htmlRoot, id), { recursive: true, force: true });
      await saveIndex();
    },
  };
}
