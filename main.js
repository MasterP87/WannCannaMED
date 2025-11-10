const { app, BrowserWindow } = require('electron');
const path = require('path');

// Start the Express server. Requiring the file will start it.
// We do this before creating the Electron window so the HTTP server
// is ready to serve pages when the window loads.
require('./server');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  // Load the local Express application. If you change the port in
  // server.js, update the URL here accordingly.
  win.loadURL('http://localhost:3000');
  // Uncomment to open DevTools automatically.
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

// On macOS it's common to recreate a window when the dock icon is clicked
// and there are no other windows open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Quit when all windows are closed, except on macOS where it's common
// for applications to stay open until the user explicitly quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});