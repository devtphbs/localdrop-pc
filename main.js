const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
    const win = new BrowserWindow({
        width: 1000, height: 700, frame: false, transparent: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile('index.html');

    win.on('maximize', () => win.webContents.send('state', 'max'));
    win.on('unmaximize', () => win.webContents.send('state', 'normal'));
}

ipcMain.on('save-file', async (event, { name, buffer, safe }) => {
    if (safe) {
        const { response } = await dialog.showMessageBox({
            type: 'info', buttons: ['Accept', 'Cancel'], message: `Accept ${name}?`
        });
        if (response !== 0) return;
    }

    const dir = path.join(app.getPath('documents'), 'LocalDropReceived');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    
    const filePath = path.join(dir, name);
    fs.writeFile(filePath, Buffer.from(buffer), () => {
        shell.showItemInFolder(filePath);
        event.reply('play-snd', 'in');
    });
});

ipcMain.on('ctrl', (e, act) => {
    const win = BrowserWindow.getFocusedWindow();
    if(act === 'close') app.quit();
    if(act === 'min') win.minimize();
    if(act === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
});

app.whenReady().then(createWindow);