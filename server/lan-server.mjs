#!/usr/bin/env node
// LAN Artifacts HTTP server: dependency-free node:http implementation.
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

import { createStorage, StorageError } from './storage.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const MAX_HTML_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_HTML_BYTES + 64 * 1024; // JSON 包装开销
const HEARTBEAT_MS = 30_000;

// 安全头照搬 claude-artifacts-mvp/server.mjs；srcdoc iframe 视作 'self'，frame-src 放行。
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
    throw new StorageError('BAD_REQUEST', 'Content-Type 必须是 application/json。', 400);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new StorageError('TOO_LARGE', '请求体过大（超过 16 MiB 上限）。', 413);
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StorageError('BAD_REQUEST', '请求体不是有效 JSON。', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageError('BAD_REQUEST', '请求体必须是 JSON 对象。', 400);
  }
  return parsed;
}

export function createLanServer({ storage, env = process.env }) {
  // 写令牌：env 未设置时随机生成并打印（boot 时）。
  const writeToken = env.LAN_ARTIFACT_WRITE_TOKEN || randomBytes(16).toString('hex');
  const shellHtml = readFileSync(join(ROOT, '..', 'public', 'viewer.html'), 'utf8');
  const viewerJs = readFileSync(join(ROOT, '..', 'public', 'viewer.js'), 'utf8');

  // SSE 客户端注册表：artifact id -> Set<res>
  const sseClients = new Map();

  function broadcast(id, data) {
    const set = sseClients.get(id);
    if (!set) return;
    for (const res of set) {
      if (res.destroyed || res.writableEnded) {
        set.delete(res);
        continue;
      }
      res.write(`event: version\nid: ${data.version}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  function requireAuth(request) {
    if (request.headers['x-artifact-write-token'] !== writeToken) {
      throw new StorageError('UNAUTHORIZED', '缺少或错误的 x-artifact-write-token。', 401);
    }
  }

  function origin(request) {
    return `http://${request.headers.host || '127.0.0.1'}`;
  }

  async function sse(request, response, id) {
    const artifact = await storage.getArtifact(id); // 不存在则 404
    const v = artifact.versions[artifact.versions.length - 1];
    let set = sseClients.get(id);
    if (!set) {
      set = new Set();
      sseClients.set(id, set);
    }
    set.add(response);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Last-Event-ID 恢复：已 >= 当前版本则不给历史事件（shell 加载时本来就拉最新 html）
    const last = Number.parseInt(String(request.headers['last-event-id'] ?? ''), 10);
    if (!(Number.isInteger(last) && last >= v.n)) {
      response.write(`event: version\nid: ${v.n}\ndata: ${JSON.stringify({ version: v.n, title: v.title, emoji: artifact.emoji, updatedAt: artifact.updatedAt })}\n\n`);
    }
    const timer = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write('event: heartbeat\ndata: {}\n\n');
    }, HEARTBEAT_MS);
    response.on('close', () => {
      clearInterval(timer);
      set.delete(response);
      if (set.size === 0) sseClients.delete(id);
    });
  }

  async function handle(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const m = request.method;

    if (m === 'GET' && url.pathname === '/health') {
      const artifactCount = (await storage.listArtifacts()).length;
      return send(response, 200, { ok: true, version: VERSION, artifactCount });
    }

    if (segments[0] === 'api' && segments[1] === 'artifacts') {
      const id = segments[2];
      if (!id) {
        if (m === 'GET') {
          const list = await storage.listArtifacts();
          return send(response, 200, list.map((a) => ({
            id: a.id,
            title: a.title,
            emoji: a.emoji,
            sessionId: a.sessionId,
            updatedAt: a.updatedAt,
            versionCount: a.versions.length,
            url: `${origin(request)}/v/${a.id}`,
          })));
        }
        if (m === 'POST') {
          requireAuth(request);
          const body = await readJson(request);
          const a = await storage.createArtifact({
            html: body.html,
            title: typeof body.title === 'string' ? body.title : undefined,
            emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
          });
          const v = a.versions[0];
          broadcast(a.id, { version: v.n, title: v.title, emoji: a.emoji, updatedAt: a.updatedAt });
          return send(response, 201, { id: a.id, url: `${origin(request)}/v/${a.id}`, version: v.n, title: v.title, emoji: a.emoji });
        }
        throw new StorageError('NOT_FOUND', '页面不存在。', 404);
      }

      const sub = segments[3];
      if (!sub) {
        if (m === 'GET') {
          const a = await storage.getArtifact(id);
          return send(response, 200, { ...a, versionCount: a.versions.length, url: `${origin(request)}/v/${id}` });
        }
        if (m === 'DELETE') {
          requireAuth(request);
          await storage.deleteArtifact(id);
          response.writeHead(204, { ...SECURITY_HEADERS, 'cache-control': 'no-store' });
          return response.end();
        }
        throw new StorageError('NOT_FOUND', '页面不存在。', 404);
      }

      if (sub === 'versions') {
        if (m === 'POST') {
          requireAuth(request);
          const body = await readJson(request);
          const a = await storage.appendVersion(id, {
            html: body.html,
            title: typeof body.title === 'string' ? body.title : undefined,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
          });
          const v = a.versions[a.versions.length - 1];
          broadcast(id, { version: v.n, title: v.title, emoji: a.emoji, updatedAt: a.updatedAt });
          return send(response, 201, { id, url: `${origin(request)}/v/${id}`, version: v.n, title: v.title, emoji: a.emoji });
        }
        throw new StorageError('NOT_FOUND', '页面不存在。', 404);
      }
      if (sub === 'html') {
        if (m === 'GET') {
          const param = url.searchParams.get('version');
          const { html } = await storage.getHtml(id, param ?? undefined);
          return send(response, 200, html, 'text/html; charset=utf-8');
        }
        throw new StorageError('NOT_FOUND', '页面不存在。', 404);
      }
      if (sub === 'events') {
        if (m === 'GET') return await sse(request, response, id);
        throw new StorageError('NOT_FOUND', '页面不存在。', 404);
      }
      throw new StorageError('NOT_FOUND', '页面不存在。', 404);
    }

    if (m === 'GET' && segments[0] === 'v' && segments.length === 2) {
      return send(response, 200, shellHtml, 'text/html; charset=utf-8');
    }
    if (m === 'GET' && url.pathname === '/viewer.js') {
      return send(response, 200, viewerJs, 'text/javascript; charset=utf-8');
    }
    throw new StorageError('NOT_FOUND', '页面不存在。', 404);
  }

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      await handle(request, response, url);
    } catch (error) {
      if (error instanceof StorageError) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      console.error('Unhandled request error:', error);
      return send(response, 500, { error: { code: 'INTERNAL', message: '服务暂时不可用。' } });
    }
  });
  server.writeToken = writeToken;
  return server;
}

function serverUrls(host, port) {
  const urls = [`http://127.0.0.1:${port}`];
  if (host !== '0.0.0.0') return urls;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

async function main() {
  const env = process.env;
  const dir = env.LAN_ARTIFACT_DIR || join(os.homedir(), '.lan-artifacts');
  const storage = await createStorage({ dir, env });
  const server = createLanServer({ storage, env });
  const host = env.LAN_ARTIFACT_HOST || '127.0.0.1';
  const port = Number.parseInt(env.LAN_ARTIFACT_PORT || '4173', 10);
  server.listen(port, host, () => {
    if (!env.LAN_ARTIFACT_WRITE_TOKEN) {
      console.log(`LAN Artifacts write token (LAN_ARTIFACT_WRITE_TOKEN): ${server.writeToken}`);
    }
    for (const url of serverUrls(host, port)) console.log(`LAN Artifacts: ${url}`);
    if (host === '0.0.0.0') console.log('Warning: artifacts are readable by devices on your LAN.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
