const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn, execFile } = require('child_process');

let mainWindow;

function runPowerShellJson(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, message: stderr?.trim() || error.message });
          return;
        }
        try {
          const parsed = JSON.parse(stdout || 'null');
          resolve({ ok: true, data: parsed });
        } catch (parseError) {
          resolve({ ok: false, message: `Failed to parse PowerShell JSON: ${parseError.message}` });
        }
      }
    );
  });
}

function psEscapeSingleQuoted(value) {
  return String(value ?? '').replace(/'/g, "''");
}

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

// Open native Windows Bluetooth send/receive dialogs
ipcMain.handle('open_bluetooth_wizard', (_event, mode) => {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Bluetooth wizard is only available on Windows.' };
  }

  const arg = mode === 'receive' ? '/receive' : '/send';
  try {
    const child = spawn('fsquirt.exe', [arg], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `Failed to open Bluetooth wizard: ${error.message}` };
  }
});

// Get paired Bluetooth devices from Windows
ipcMain.handle('list_bluetooth_devices', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Bluetooth device listing is only available on Windows.' };
  }

  const ps = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '[Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime] | Out-Null',
    '$selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelector()',
    '$async = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)',
    '$list = [System.WindowsRuntimeSystemExtensions]::AsTask($async).GetAwaiter().GetResult()',
    '$output = @()',
    'foreach ($d in $list) {',
    '  $isConnected = $false',
    '  if ($d.Properties.ContainsKey("System.Devices.Aep.IsConnected")) { $isConnected = [bool]$d.Properties["System.Devices.Aep.IsConnected"] }',
    '  $isPaired = $false',
    '  if ($d.Pairing -ne $null) { $isPaired = [bool]$d.Pairing.IsPaired }',
    '  $canPair = $false',
    '  if ($d.Pairing -ne $null) { $canPair = [bool]$d.Pairing.CanPair }',
    '  $containerId = ""',
    '  if ($d.Properties.ContainsKey("System.Devices.Aep.ContainerId")) { $containerId = [string]$d.Properties["System.Devices.Aep.ContainerId"] }',
    '  $output += [pscustomobject]@{',
    '    id = $d.Id',
    '    name = $d.Name',
    '    isPaired = $isPaired',
    '    isConnected = $isConnected',
    '    canPair = $canPair',
    '    containerId = $containerId',
    '    pairingProtection = (if ($d.Pairing -ne $null) { [string]$d.Pairing.ProtectionLevel } else { "" })',
    '  }',
    '}',
    '$filtered = $output | Where-Object { $_.name -and $_.isPaired } | Sort-Object name -Unique',
    'if ($filtered) { $filtered | ConvertTo-Json -Depth 6 } else { @() | ConvertTo-Json -Depth 6 }'
  ].join('; ');

  const result = await runPowerShellJson(ps);
  if (!result.ok) return result;

  const asArray = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
  const devices = asArray.map((d) => ({
    id: d.id,
    name: d.name,
    isPaired: Boolean(d.isPaired),
    isConnected: Boolean(d.isConnected),
    canPair: Boolean(d.canPair),
    containerId: d.containerId || '',
    pairingProtection: d.pairingProtection || ''
  }));

  return { ok: true, devices };
});

// Try direct OBEX-style send first; fall back to native wizard
ipcMain.handle('send_file_bluetooth', async (_event, payload) => {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Bluetooth sending is only available on Windows.' };
  }

  const { filePath, deviceName, deviceId } = payload || {};
  if (!filePath) return { ok: false, message: 'No file selected.' };
  if (!deviceName) return { ok: false, message: 'No Bluetooth device selected.' };

  const escapedPath = psEscapeSingleQuoted(filePath);
  const escapedDevice = psEscapeSingleQuoted(deviceName);
  const escapedDeviceId = psEscapeSingleQuoted(deviceId || '');

  // Multi-strategy direct attempt using WinRT discovery + shell verbs.
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$targetName = '${escapedDevice}'`,
    `$targetId = '${escapedDeviceId}'`,
    `$filePath = '${escapedPath}'`,
    '$log = @()',
    '$directSuccess = $false',
    'if (-not (Test-Path -LiteralPath $filePath)) { throw "Selected file no longer exists." }',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '[Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime] | Out-Null',
    '$selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelector()',
    '$async = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)',
    '$devices = [System.WindowsRuntimeSystemExtensions]::AsTask($async).GetAwaiter().GetResult()',
    '$match = $null',
    'foreach ($d in $devices) {',
    '  if (($targetId -and $d.Id -eq $targetId) -or ($d.Name -eq $targetName)) { $match = $d; break }',
    '}',
    'if ($match -eq $null) {',
    '  $log += "Target device not found in WinRT list."',
    '} else {',
    '  $log += "WinRT target found: " + $match.Name',
    '}',
    '$shell = New-Object -ComObject Shell.Application',
    '$btFolder = $shell.Namespace(17)',
    '$target = $null',
    'if ($btFolder -ne $null) {',
    '  foreach ($item in $btFolder.Items()) {',
    '    if ($item.Name -eq $targetName) { $target = $item; break }',
    '  }',
    '}',
    'if ($target -ne $null) {',
    '  try {',
    '    $log += "Trying CopyHere strategy."',
    '    $target.GetFolder.CopyHere($filePath, 16)',
    '    Start-Sleep -Milliseconds 600',
    '    $directSuccess = $true',
    '  } catch {',
    '    $log += "CopyHere failed: " + $_.Exception.Message',
    '  }',
    '  if (-not $directSuccess) {',
    '    try {',
    '      $log += "Trying InvokeVerb Send-a-File strategy."',
    '      $target.InvokeVerb("Send a File")',
    '      Start-Sleep -Milliseconds 500',
    '      $directSuccess = $true',
    '    } catch {',
    '      $log += "InvokeVerb failed: " + $_.Exception.Message',
    '    }',
    '  }',
    '} else {',
    '  $log += "Shell Bluetooth target not found."',
    '}'
    ,
    '[pscustomobject]@{ directAttempted = $true; directSuccess = $directSuccess; details = $log } | ConvertTo-Json -Depth 6'
  ].join('; ');

  const attempt = await runPowerShellJson(ps);

  if (attempt.ok && attempt.data?.directSuccess) {
    return { ok: true, used: 'direct', details: attempt.data?.details || [] };
  }

  // Fallback: open native wizard where user can choose device/file.
  try {
    const child = spawn('fsquirt.exe', ['/send'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return {
      ok: true,
      used: 'wizard',
      message: 'Direct send was not available. Opened Windows Bluetooth wizard.',
      details: attempt.ok ? (attempt.data?.details || []) : [attempt.message || 'Direct attempt failed before fallback.']
    };
  } catch (error) {
    return {
      ok: false,
      message: `Direct send failed and wizard launch failed: ${error.message}`,
      details: attempt.ok ? (attempt.data?.details || []) : [attempt.message || 'Direct attempt failed before fallback.']
    };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
