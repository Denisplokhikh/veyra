import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

export function createMihomoRuntime({ root, resourceRoot = root, runtimeRoot = root, buildMihomoProfile }) {
  const paths = {
    binary: process.env.MIHOMO_BIN || getBundledMihomoBinary(),
    fallbackBinary: path.join(root, 'engine/bin/mihomo.exe'),
    runtimeBinary: path.join(runtimeRoot, 'engine/bin/mihomo.exe'),
    configDir: path.join(runtimeRoot, 'engine/configs'),
    activeConfig: path.join(runtimeRoot, 'engine/configs/active.yaml'),
    logDir: path.join(runtimeRoot, 'engine/logs'),
    logFile: path.join(runtimeRoot, 'engine/logs/mihomo.log'),
    trafficState: path.join(runtimeRoot, 'engine/traffic-state.json')
  };
  let traffic = {
    up: 0,
    down: 0,
    totalUp: 0,
    totalDown: 0,
    updatedAt: null
  };
  let trafficAbortController = null;
  let trafficSaveTimer = null;
  let child = null;
  let startedAt = null;
  let lastExit = null;
  let logCleanupTimer = null;

  return {
    prepare,
    status,
    start,
    stop,
    logs,
    traffic: getTraffic
  };

  async function prepare() {
    paths.binary = await resolveMihomoBinary();
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await loadTrafficState();
    scheduleLogAutoDelete();
  }

  async function status() {
    const binaryExists = await exists(paths.binary);
    return {
      running: Boolean(child && !child.killed),
      pid: child?.pid || null,
      startedAt,
      lastExit,
      binary: paths.binary,
      binaryExists,
      activeConfig: paths.activeConfig,
      logFile: paths.logFile
    };
  }

  async function start(profile) {
    if (child && !child.killed) {
      return { ...(await status()), message: 'Mihomo is already running' };
    }

    if (!(await exists(paths.binary))) {
      throw publicError(409, `Mihomo binary not found: ${paths.binary}`);
    }

    if (needsWindowsTunAdmin(profile) && !isWindowsElevated()) {
      throw publicError(
        409,
        'TUN on Windows requires administrator rights. Run the desktop app as administrator or disable TUN in Settings.'
      );
    }

    const generated = buildMihomoProfile(profile);
    await prepare();
    await fs.writeFile(paths.activeConfig, generated.yaml);

    const logStream = createWriteStream(paths.logFile, { flags: 'a' });
    logStream.write(`\n[${new Date().toISOString()}] starting mihomo with ${paths.activeConfig}\n`);

    child = spawn(paths.binary, ['-f', paths.activeConfig], {
      cwd: runtimeRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    startedAt = new Date().toISOString();
    lastExit = null;

    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('exit', (code, signal) => {
      stopTrafficWatcher();
      void saveTrafficState();
      lastExit = { code, signal, at: new Date().toISOString() };
      logStream.write(`[${lastExit.at}] mihomo exited code=${code} signal=${signal || ''}\n`);
      logStream.end();
      child = null;
      startedAt = null;
    });

    child.on('error', (error) => {
      lastExit = { code: null, signal: 'error', at: new Date().toISOString(), message: error.message };
      logStream.write(`[${lastExit.at}] mihomo error: ${error.message}\n`);
    });

    await wait(800);
    await failIfTunAccessDenied();
    startTrafficWatcher(profile);
    return {
      ...(await status()),
      summary: generated.summary,
      warnings: generated.warnings
    };
  }

  async function stop() {
    if (!child || child.killed) {
      return { ...(await status()), message: 'Mihomo is not running' };
    }

    const pid = child.pid;
    stopTrafficWatcher();
    await saveTrafficState();
    child.kill();
    return { ...(await status()), message: `Stop signal sent to ${pid}` };
  }

  async function logs(limit = 6000) {
    if (!(await exists(paths.logFile))) {
      return { text: '' };
    }

    const file = await fs.open(paths.logFile, 'r');
    try {
      const stat = await file.stat();
      const start = Math.max(0, stat.size - limit);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      return { text: buffer.toString('utf8') };
    } finally {
      await file.close();
    }
  }

  async function getTraffic() {
    return { ...traffic };
  }

  async function loadTrafficState() {
    try {
      const saved = JSON.parse(await fs.readFile(paths.trafficState, 'utf8'));
      traffic = {
        up: 0,
        down: 0,
        totalUp: safeTrafficNumber(saved.totalUp),
        totalDown: safeTrafficNumber(saved.totalDown),
        updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null
      };
    } catch {
      traffic = {
        up: 0,
        down: 0,
        totalUp: 0,
        totalDown: 0,
        updatedAt: null
      };
    }
  }

  async function saveTrafficState() {
    clearTrafficSaveTimer();
    await fs.mkdir(path.dirname(paths.trafficState), { recursive: true });
    await fs.writeFile(paths.trafficState, JSON.stringify({
      totalUp: Math.round(safeTrafficNumber(traffic.totalUp)),
      totalDown: Math.round(safeTrafficNumber(traffic.totalDown)),
      updatedAt: traffic.updatedAt || new Date().toISOString()
    }, null, 2));
  }

  function scheduleTrafficSave() {
    if (trafficSaveTimer) return;

    trafficSaveTimer = setTimeout(() => {
      trafficSaveTimer = null;
      saveTrafficState().catch((error) => {
        console.warn(`Could not save Mihomo traffic state: ${error.message}`);
      });
    }, 2000);
    trafficSaveTimer.unref?.();
  }

  function clearTrafficSaveTimer() {
    if (!trafficSaveTimer) return;
    clearTimeout(trafficSaveTimer);
    trafficSaveTimer = null;
  }

  function startTrafficWatcher(profile) {
    stopTrafficWatcher();

    const controllerUrl = `${getControllerBaseUrl(profile)}/traffic`;
    trafficAbortController = new AbortController();

    void watchTraffic(controllerUrl, trafficAbortController.signal);
  }

  async function watchTraffic(controllerUrl, signal) {
    try {
      const response = await fetch(controllerUrl, { signal });
      if (!response.ok || !response.body) return;

      let buffer = '';
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          updateTrafficFromLine(line);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn(`Could not read Mihomo traffic: ${error.message}`);
      }
    }
  }

  function updateTrafficFromLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const data = JSON.parse(trimmed);
      const up = safeTrafficNumber(data.up);
      const down = safeTrafficNumber(data.down);

      traffic.up = up;
      traffic.down = down;
      traffic.totalUp += up;
      traffic.totalDown += down;
      traffic.updatedAt = new Date().toISOString();
      scheduleTrafficSave();
    } catch {
      // Mihomo traffic stream is line-delimited JSON; ignore malformed fragments.
    }
  }

  function stopTrafficWatcher() {
    if (trafficAbortController) {
      trafficAbortController.abort();
      trafficAbortController = null;
    }

    traffic.up = 0;
    traffic.down = 0;
  }

  function getControllerBaseUrl(profile) {
    const value = String(profile?.externalController || '127.0.0.1:9090').trim();
    if (/^https?:\/\//i.test(value)) {
      return value.replace(/\/+$/, '');
    }
    return `http://${value.replace(/\/+$/, '')}`;
  }

  function getBundledMihomoBinary() {
    const executable = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
    const unpackedRoot = root.includes('app.asar')
      ? path.join(resourceRoot, 'app.asar.unpacked')
      : resourceRoot;

    return path.join(unpackedRoot, 'engine/bin', executable);
  }

  async function resolveMihomoBinary() {
    if (process.env.MIHOMO_BIN) return process.env.MIHOMO_BIN;
    if (await exists(paths.binary)) return paths.binary;

    if (root.includes('app.asar') && await exists(paths.fallbackBinary)) {
      await fs.mkdir(path.dirname(paths.runtimeBinary), { recursive: true });
      await fs.copyFile(paths.fallbackBinary, paths.runtimeBinary);
      return paths.runtimeBinary;
    }

    if (await exists(paths.runtimeBinary)) return paths.runtimeBinary;
    return paths.binary;
  }

  async function failIfTunAccessDenied() {
    if (!child || child.killed) return;

    const recentLogs = await logs(12000);
    if (!/Start TUN listening error/i.test(recentLogs.text) || !/Access is denied/i.test(recentLogs.text)) {
      return;
    }

    await stop();
    throw publicError(
      409,
      'TUN failed to start because Windows denied access. Run the desktop app as administrator or disable TUN in Settings.'
    );
  }

  function scheduleLogAutoDelete() {
    if (logCleanupTimer) return;

    const retentionMs = Number(process.env.MIHOMO_LOG_RETENTION_MS || 24 * 60 * 60 * 1000);
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) return;

    const intervalMs = Math.min(Math.max(Math.floor(retentionMs / 4), 60 * 1000), 60 * 60 * 1000);
    const cleanup = async () => {
      if (child && !child.killed) return;

      try {
        const stat = await fs.stat(paths.logFile);
        if (Date.now() - stat.mtimeMs >= retentionMs) {
          await fs.rm(paths.logFile, { force: true });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`Could not auto-delete Mihomo log: ${error.message}`);
        }
      }
    };

    cleanup();
    logCleanupTimer = setInterval(cleanup, intervalMs);
    logCleanupTimer.unref?.();
  }

  async function exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function safeTrafficNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function needsWindowsTunAdmin(profile) {
  return process.platform === 'win32' && Boolean(profile?.tun?.enabled);
}

function isWindowsElevated() {
  if (process.platform !== 'win32') return true;

  try {
    execFileSync('fltmc.exe', [], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}
