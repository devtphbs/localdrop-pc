const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    frame: false, // Removes default system bar so we can use our custom one
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // Check for updates every 10 minutes
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 600000);
}

app.whenReady().then(() => {
  createWindow();
  autoUpdater.checkForUpdatesAndNotify();
});

// Window Controls
ipcMain.on('min', () => mainWindow.minimize());
ipcMain.on('max', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('close', () => mainWindow.close());

// Auto-Update Logic
autoUpdater.on('update-available', () => {
  mainWindow.webContents.send('update_available');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('update_available'); // Triggers the bar in index.html
});

ipcMain.on('restart_app', () => {
  autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
