import { app, BrowserWindow, shell } from 'electron';
import { startServer } from '../api/server.js';

let apiServer = null;
let mainWindow = null;

app.setName('Mihomo VPN Configurator');

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainWindow();
  });

  app.whenReady().then(createMainWindow).catch(showStartupError);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow().catch(showStartupError);
    } else {
      restoreMainWindow();
    }
  });
}

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    restoreMainWindow();
    return;
  }

  const api = await startServer({ host: '127.0.0.1', port: 0 });
  apiServer = api.server;

  mainWindow = createWindow();
  mainWindow.once('ready-to-show', restoreMainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://${api.host}:${api.port}`);
  restoreMainWindow();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: 'Mihomo VPN Configurator',
    backgroundColor: '#080d17',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return window;
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
}

async function showStartupError(error) {
  console.error(error);

  if (!app.isReady()) {
    await app.whenReady();
  }

  mainWindow = createWindow();
  mainWindow.once('ready-to-show', restoreMainWindow);
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Mihomo VPN Configurator</title>
        <style>
          body {
            margin: 0;
            padding: 32px;
            background: #080d17;
            color: #e5eefc;
            font-family: system-ui, sans-serif;
          }
          pre {
            white-space: pre-wrap;
            color: #f87171;
          }
        </style>
      </head>
      <body>
        <h1>Не удалось запустить приложение</h1>
        <p>Backend или окно Electron упали при старте.</p>
        <pre>${escapeHtml(error?.stack || error?.message || error)}</pre>
      </body>
    </html>
  `)}`);
  restoreMainWindow();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
});
