import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import { startServer } from '../api/server.js';

const APP_NAME = 'Veyra';
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALKSURBVFhH7VcxaBRBFE0ZREVRiRKUiKiBSAgJ4t0ucleIRCwMgkGQgAGLAxUPERQOs5lJESxEsFQkYHNgc4JFOjsRwUrBgE1sRCsP5GbWQhh5c7t7t3929nbvks4Hj81e/vz3dubPn92hof/oE47XmnJX/HJI3NOYLUXJU8MOb113mag7XPgulyqRTDYcJiolr7mH5ugbSOhw+cMQS6HDZdNlogrjNF9m4CkcLt/T5Dm5ccbzx2junsAgl4vNhIS5qWdjxS9TDSvw5FslHhImit7vcaploF1s2aZ9+tZHNXnjrb7S/yVTbPYsThSOObDDmepndWh6QQ3vGtEsnZ+L/h6ZnFdTlXfGmG46XD6hmhGCp7dW+/j8S7Vj7xEtdm3xtvrw6Zv6/uuvvuI+NDJ2blkVl5rG+LYB4Ze81kGqrYHtRgeEPHH5uSFM2W3k8Nm7Ro6OCX+Vams4TK7TYBDTXr5wxSpMiTgsDeqD5gq4QbWDPZ/c4Q5MXFL3Hz4yhNKI+N2jM0aukMaOcD1RoEE6cKmpp7QfAxh3+t5XI6fOy8VczAB+oEEgqnoQAxMLr42cmkxUYwZsBRgWX78Gjs6uGjkDA8sxA0UurxpBXKpTi+sDGcDWpTnbBloPYgb0uU6DuFSF2s+BDNi6JB44ZgDNgQaFRDVX7tQMkTQiHk2L5oroiULMAGA7A8JlePqsbgglEXGIP3bxsZELRLel2hooDBoccrR4M5OJUHzfyVkjR0Qm16i2BpbB1oxQCzhs0kx0i9v2P5j6/ojTig7oJqp65/7jhgncY81t0x6RyQbVjKE9C/YTMST6/Is3X7Q4ril9PyJm12jBSUCF2paCsvbqj/GbjcbWSwOCs5rIRNr5skB/cOCFkibLQT3teZ6cQjcoJuo0cSYy2ci05lmgP8WYXOtVoMEHST3Xa3he6HcHvLyicXVY3VbR7cI/nJ8C4S+dY7oAAAAASUVORK5CYII=';
const TRAY_ICON_FILES = ['icon.ico', 'Icon.png', 'icon.png'];
const isDevInstance = process.env.VEYRA_DEV_INSTANCE === '1';
const windowTitle = isDevInstance ? `${APP_NAME} Dev` : APP_NAME;
let apiServer = null;
let apiAddress = null;
let mainWindow = null;

let tray = null;
let isQuitting = false;

app.setName(windowTitle);
if (isDevInstance) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openMainWindow();
  });

  app.whenReady().then(async () => {
    createTray();
    await createMainWindow();
  }).catch(showStartupError);

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

  if (!apiServer || !apiAddress) {
    const api = await startServer({ host: '127.0.0.1', port: 0 });
    apiServer = api.server;
    apiAddress = { host: api.host, port: api.port };
  }

  mainWindow = createWindow();
  mainWindow.once('ready-to-show', restoreMainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://${apiAddress.host}:${apiAddress.port}`);
  restoreMainWindow();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: windowTitle,
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

  window.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();
    window.hide();
  });

  return window;
}

function setOpenAtLogin(openAtLogin) {
  app.setLoginItemSettings({
    openAtLogin,
    path: app.getPath('exe')
  });
}

function createTray() {
  if (tray) return;

  tray = new Tray(getTrayIcon());
  tray.setToolTip(windowTitle);

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Открыть',
      click: openMainWindow
    },
    {
      label: 'Скрыть',  
      click: () => {
        mainWindow?.hide();
      }
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));

  tray.on('click', openMainWindow);
  tray.on('double-click', openMainWindow);
}

function getTrayIcon() {
  const iconPath = findTrayIconPath();
  if (iconPath) {
    if (path.extname(iconPath).toLowerCase() === '.ico') {
      return iconPath;
    }

    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return nativeImage.createFromDataURL(TRAY_ICON_DATA_URL).resize({ width: 16, height: 16 });
}

function findTrayIconPath() {
  const appPath = app.getAppPath();
  const roots = [
    DESKTOP_DIR,
    path.join(appPath, 'apps', 'desktop')
  ];

  for (const root of roots) {
    for (const file of TRAY_ICON_FILES) {
      const candidate = path.join(root, file);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function openMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow().catch(showStartupError);
    return;
  }

  restoreMainWindow();
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
  if (isQuitting || !tray) {
    app.quit();
  }
});



app.on('before-quit', () => {
  isQuitting = true;

  if (apiServer) {
    apiServer.close();
    apiServer = null;
    apiAddress = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }
});
