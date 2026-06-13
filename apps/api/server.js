import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildMihomoProfile, createDefaultProfile, parseSubscriptionText, parseVlessUri } from '../../packages/mihomo-engine/index.js';
import { createMihomoRuntime } from './mihomo-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WEB_ROOT = path.join(ROOT, 'apps/web');
const PACKAGED_APP = isPackagedAppRoot(ROOT);
const USER_DATA_ROOT = process.env.MIHOMO_USER_DATA || getDefaultUserDataRoot();
const DATA_ROOT = process.env.MIHOMO_DATA_ROOT || path.join(PACKAGED_APP ? USER_DATA_ROOT : ROOT, 'data');
const PROFILE_ROOT = path.join(DATA_ROOT, 'profiles');
const APP_STATE_PATH = path.join(DATA_ROOT, 'app-state.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;
const REMOTE_SUBSCRIPTION_TIMEOUT_MS = 15000;
const TCP_PING_TIMEOUT_MS = 4000;
const TCP_PING_CONCURRENCY = 8;
const MAX_TCP_PING_NODES = 100;
const KOALA_COMPAT_USER_AGENT = 'koala-clash/1.3.1';
const runtime = createMihomoRuntime({
  root: ROOT,
  resourceRoot: getResourceRoot(),
  runtimeRoot: PACKAGED_APP ? USER_DATA_ROOT : ROOT,
  buildMihomoProfile
});

export async function startServer(options = {}) {
  const host = options.host || HOST;
  const port = Number(options.port ?? PORT);

  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(PROFILE_ROOT, { recursive: true });
  await runtime.prepare();

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.publicMessage || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Mihomo VLESS Configurator is running at http://${host}:${actualPort}`);

  return { server, host, port: actualPort };
}

if (isEntrypoint()) {
  await startServer();
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, engine: 'mihomo', version: '0.1.0' });
  }

  if (request.method === 'GET' && url.pathname === '/api/sample') {
    return sendJson(response, 200, createDefaultProfile());
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(response, 200, await loadAppState());
  }

  if (request.method === 'POST' && url.pathname === '/api/state') {
    return sendJson(response, 200, await saveAppState(await readJson(request)));
  }

  if (request.method === 'POST' && url.pathname === '/api/import') {
    const body = await readJson(request);
    const source = await resolveImportSource(body.text || body.uri || '', { userAgent: body.ua });
    const imported = parseSubscriptionText(source.text);
    return sendJson(response, 200, {
      ...imported,
      source: source.type,
      url: source.url,
      userAgent: source.userAgent,
      profile: source.profile
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/parse') {
    const body = await readJson(request);
    const node = parseVlessUri(body.uri || '');
    return sendJson(response, 200, { node });
  }

  if (request.method === 'POST' && url.pathname === '/api/ping/tcp') {
    const body = await readJson(request);
    const timeoutMs = clampNumber(body.timeoutMs, 500, 10000, TCP_PING_TIMEOUT_MS);
    const nodes = normalizeTcpPingNodes(body.nodes || (body.node ? [body.node] : []));
    const results = await mapWithConcurrency(nodes, TCP_PING_CONCURRENCY, (node) => tcpPingNode(node, timeoutMs));
    return sendJson(response, 200, { results, timeoutMs });
  }

  if (request.method === 'POST' && url.pathname === '/api/generate') {
    const profile = await readJson(request);
    const generated = buildMihomoProfile(profile);
    return sendJson(response, 200, generated);
  }

  if (request.method === 'GET' && url.pathname === '/api/profiles') {
    return sendJson(response, 200, { profiles: await listProfiles() });
  }

  if (request.method === 'GET' && url.pathname === '/api/runtime/status') {
    return sendJson(response, 200, await runtime.status());
  }

  if (request.method === 'POST' && url.pathname === '/api/runtime/start') {
    const profile = await readJson(request);
    return sendJson(response, 200, await runtime.start(profile));
  }

  if (request.method === 'POST' && url.pathname === '/api/runtime/stop') {
    return sendJson(response, 200, await runtime.stop());
  }

  if (request.method === 'GET' && url.pathname === '/api/runtime/logs') {
    return sendJson(response, 200, await runtime.logs(Number(url.searchParams.get('limit')) || undefined));
  }

  if (request.method === 'POST' && url.pathname === '/api/profiles') {
    const profile = await readJson(request);
    const generated = buildMihomoProfile(profile);
    const id = makeProfileId(profile.name);
    const now = new Date().toISOString();
    const jsonPath = path.join(PROFILE_ROOT, `${id}.json`);
    const yamlPath = path.join(PROFILE_ROOT, `${id}.yaml`);

    await fs.writeFile(jsonPath, JSON.stringify({ id, createdAt: now, profile, summary: generated.summary }, null, 2));
    await fs.writeFile(yamlPath, generated.yaml);

    return sendJson(response, 201, {
      id,
      createdAt: now,
      summary: generated.summary,
      warnings: generated.warnings,
      downloadUrl: `/api/profiles/${id}/download`
    });
  }

  const downloadMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9-]+)\/download$/);
  if (request.method === 'GET' && downloadMatch) {
    const id = downloadMatch[1];
    const yamlPath = path.join(PROFILE_ROOT, `${id}.yaml`);
    const yaml = await fs.readFile(yamlPath, 'utf8');
    response.writeHead(200, {
      'content-type': 'application/x-yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${id}.yaml"`
    });
    return response.end(yaml);
  }
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9-]+)$/);

  if (request.method === 'DELETE' && profileMatch) {
    const id = profileMatch[1];

    await fs.rm(path.join(PROFILE_ROOT, `${id}.json`), { force: true });
    await fs.rm(path.join(PROFILE_ROOT, `${id}.yaml`), { force: true });

    return sendJson(response, 200, { ok: true, id });
  }
  if (request.method === 'GET') {
    return serveStatic(url.pathname, response);
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      error.publicMessage = 'Request body is too large';
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.statusCode = 400;
    error.publicMessage = 'Invalid JSON body';
    throw error;
  }
}

async function resolveImportSource(input, options = {}) {
  const source = String(input || '').trim();
  if (!source) {
    return { type: 'text', text: '' };
  }

  if (!isRemoteSubscriptionUrl(source)) {
    return { type: 'text', text: source };
  }

  return fetchRemoteSubscription(source, options);
}

function isRemoteSubscriptionUrl(source) {
  if (/\s/.test(source)) return false;

  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchRemoteSubscription(url, options = {}) {
  const attempts = [];
  let bestAttempt = null;
  const userAgents = uniqueStrings([
    options.userAgent,
    KOALA_COMPAT_USER_AGENT,
    'ClashforWindows/0.20.39',
    'Stash/2.5.0'
  ]);

  for (const userAgent of userAgents) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_SUBSCRIPTION_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: getSubscriptionHeaders(userAgent)
      });

      if (!response.ok) {
        attempts.push(`HTTP ${response.status} for ${userAgent}`);
        continue;
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('text/xml')) {
        attempts.push(`unsupported content-type ${contentType || 'unknown'} for ${userAgent}`);
        continue;
      }

      const text = await readLimitedText(response, MAX_REMOTE_SUBSCRIPTION_BYTES);
      const parsed = parseSubscriptionText(text);
      const result = {
        type: 'url',
        url,
        text,
        userAgent,
        profile: getSubscriptionProfileMeta(response.headers)
      };

      if (parsed.nodes.length) {
        return result;
      }

      attempts.push(`0 nodes for ${userAgent}`);
      if (!bestAttempt) bestAttempt = result;
    } catch (error) {
      if (error.name === 'AbortError') {
        attempts.push(`timeout for ${userAgent}`);
      } else if (error.publicMessage) {
        throw error;
      } else {
        attempts.push(`${error.message} for ${userAgent}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (bestAttempt) return bestAttempt;

  throw publicError(502, `Could not fetch subscription: ${attempts.join('; ') || 'unknown error'}`);
}

async function readLimitedText(response, limit) {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw publicError(413, 'Remote subscription is too large');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw publicError(413, 'Remote subscription is too large');
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function getSubscriptionHeaders(userAgent) {
  return {
    accept: 'text/yaml, text/plain, application/octet-stream, */*',
    'user-agent': userAgent || KOALA_COMPAT_USER_AGENT,
    'x-hwid': getHWID(),
    'x-device-os': getDeviceOS(),
    'x-ver-os': getOSVersion(),
    'x-device-model': getDeviceModel()
  };
}

function getHWID() {
  let raw = '';

  if (process.platform === 'win32') {
    raw = execCommand('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    raw = raw.match(/MachineGuid\s+REG_SZ\s+(.+)/)?.[1]?.trim() || '';
  } else if (process.platform === 'linux') {
    raw = readSystemFile('/etc/machine-id') || readSystemFile('/var/lib/dbus/machine-id');
  } else if (process.platform === 'darwin') {
    raw = execCommand('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    raw = raw.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '';
  }

  if (!raw) {
    const macs = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && !item.internal && item.mac && item.mac !== '00:00:00:00:00:00')
      .map((item) => item.mac)
      .sort();
    raw = `${macs.join(':')}:${os.hostname()}:${os.cpus()[0]?.model || ''}`;
  }

  return crypto.createHash('sha256').update(raw || os.hostname()).digest('hex').slice(0, 16);
}

function getDeviceOS() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

function getOSVersion() {
  return os.release();
}

function getDeviceModel() {
  if (process.platform === 'win32') {
    const product = execCommand('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'ProductName']);
    const productName = product.match(/ProductName\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    return productName || `Windows ${os.release()}`;
  }

  if (process.platform === 'darwin') {
    return execCommand('sysctl', ['-n', 'hw.model']) || 'Mac';
  }

  if (process.platform === 'linux') {
    const osRelease = readSystemFile('/etc/os-release');
    return osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || 'Linux';
  }

  return process.platform;
}

function execCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function readSystemFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function getSubscriptionProfileMeta(headers) {
  const title = getHeaderEnding(headers, 'profile-title');
  const home = getHeaderEnding(headers, 'profile-web-page-url');
  const updateInterval = Number(getHeaderEnding(headers, 'profile-update-interval') || 0);
  const userinfo = getHeaderEnding(headers, 'subscription-userinfo');

  return compactObject({
    title: decodeHeaderValue(title),
    home,
    updateIntervalSeconds: updateInterval ? updateInterval * 60 : undefined,
    userinfo: parseSubscriptionUserInfo(userinfo)
  });
}

function getHeaderEnding(headers, suffix) {
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase().endsWith(suffix)) {
      return value;
    }
  }
  return '';
}

function decodeHeaderValue(value) {
  if (!value) return undefined;
  if (value.startsWith('base64:')) {
    return Buffer.from(value.slice(7), 'base64').toString('utf8');
  }
  return value;
}

function parseSubscriptionUserInfo(value) {
  if (!value) return undefined;
  return Object.fromEntries(
    value
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, item]) => key && item !== undefined)
      .map(([key, item]) => [key, Number(item)])
  );
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    })
  );
}

async function listProfiles() {
  const files = await fs.readdir(PROFILE_ROOT);
  const profiles = [];

  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const content = await fs.readFile(path.join(PROFILE_ROOT, file), 'utf8');
      const meta = JSON.parse(content);
      profiles.push({
        id: meta.id,
        createdAt: meta.createdAt,
        summary: meta.summary,
        downloadUrl: `/api/profiles/${meta.id}/download`
      });
    } catch {
      // Ignore malformed profile metadata and keep the API usable.
    }
  }

  return profiles.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function loadAppState() {
  try {
    const content = await fs.readFile(APP_STATE_PATH, 'utf8');
    const state = JSON.parse(content);
    return normalizeAppState(state);
  } catch {
    return normalizeAppState({});
  }
}

async function saveAppState(state) {
  const normalized = {
    ...normalizeAppState(state),
    updatedAt: new Date().toISOString()
  };

  await fs.writeFile(APP_STATE_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

function normalizeAppState(state) {
  return {
    profile: isPlainObject(state?.profile) ? state.profile : null,
    importText: typeof state?.importText === 'string' ? state.importText : '',
    configs: Array.isArray(state?.configs) ? state.configs.filter(isPlainObject) : [],
    activeConfigId: typeof state?.activeConfigId === 'string' ? state.activeConfigId : null,
    updatedAt: typeof state?.updatedAt === 'string' ? state.updatedAt : null
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeTcpPingNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .slice(0, MAX_TCP_PING_NODES)
    .map((node, index) => ({
      index,
      pingKey: String(node?.pingKey || `${node?.server || node?.host || ''}:${node?.port || 443}:${node?.uuid || node?.name || index}`),
      name: String(node?.name || `Server ${index + 1}`),
      server: String(node?.server || node?.host || '').trim(),
      port: Number(node?.port) || 443
    }));
}

async function tcpPingNode(node, timeoutMs) {
  if (!node.server || node.port < 1 || node.port > 65535) {
    return {
      ...node,
      ok: false,
      latencyMs: null,
      error: 'Invalid host or port'
    };
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const startedAt = performance.now();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...node,
        ...result
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({
        ok: true,
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
        error: null
      });
    });
    socket.once('timeout', () => {
      finish({
        ok: false,
        latencyMs: null,
        error: 'Timeout'
      });
    });
    socket.once('error', (error) => {
      finish({
        ok: false,
        latencyMs: null,
        error: error.code || error.message
      });
    });

    try {
      socket.connect(node.port, node.server);
    } catch (error) {
      finish({
        ok: false,
        latencyMs: null,
        error: error.code || error.message
      });
    }
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function serveStatic(requestPath, response) {
  const safePath = requestPath === '/' ? '/index.html' : requestPath;
  const target = path.resolve(WEB_ROOT, `.${safePath}`);

  if (!isInsideRoot(target, WEB_ROOT)) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }

  try {
    const stat = await fs.stat(target);
    const filePath = stat.isDirectory() ? path.join(target, 'index.html') : target;
    const content = await fs.readFile(filePath);
    response.writeHead(200, { 'content-type': getContentType(filePath) });
    response.end(content);
  } catch {
    const index = await fs.readFile(path.join(WEB_ROOT, 'index.html'));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(index);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function publicError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function getContentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

function makeProfileId(name) {
  const slug = String(name || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'profile';
  return `${slug}-${Date.now().toString(36)}`;
}

function isInsideRoot(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPackagedAppRoot(root) {
  return root.split(path.sep).includes('app.asar') || root.includes('app.asar');
}

function getResourceRoot() {
  if (process.resourcesPath) return process.resourcesPath;
  if (PACKAGED_APP) return path.dirname(ROOT);
  return ROOT;
}

function getDefaultUserDataRoot() {
  const appName = 'Mihomo VPN Configurator';

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

function isEntrypoint() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry === fileURLToPath(import.meta.url);
}
