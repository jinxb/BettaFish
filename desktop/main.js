const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const BACKEND_URL = 'http://127.0.0.1:5000';
const BACKEND_HEALTH_ENDPOINT = `${BACKEND_URL}/api/status`;
const BACKEND_TIMEOUT_MS = 180000;
const BACKEND_CHECK_INTERVAL_MS = 1000;

let pythonProcess = null;
let mainWindow = null;
let backendReady = false;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.bettafish.desktop');
    }
    await launchApplication();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (backendReady) {
          createMainWindow();
        } else {
          waitForBackendReady()
            .then(() => {
              if (BrowserWindow.getAllWindows().length === 0) {
                createMainWindow();
              }
            })
            .catch((error) => {
              showStartupError(error);
              app.quit();
            });
        }
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackend();
  });
}

function logBackendOutput(prefix, data) {
  const text = data.toString();
  if (text.trim().length > 0) {
    process.stdout.write(`[backend ${prefix}] ${text}`);
  }
}

function pingBackend(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
        resolve();
      } else {
        reject(new Error(`Unexpected status code ${response.statusCode}`));
      }
    });

    request.on('error', reject);
    request.setTimeout(3000, () => {
      request.destroy(new Error('Request timed out'));
    });
  });
}

async function waitForBackendReady() {
  const start = Date.now();
  while (Date.now() - start < BACKEND_TIMEOUT_MS) {
    try {
      await pingBackend(BACKEND_HEALTH_ENDPOINT);
      backendReady = true;
      return;
    } catch (error) {
      if (!pythonProcess || pythonProcess.exitCode !== null) {
        throw new Error('The Python backend process exited before becoming ready.');
      }
      await new Promise((resolve) => setTimeout(resolve, BACKEND_CHECK_INTERVAL_MS));
    }
  }
  throw new Error('Timed out waiting for the Python backend to become ready.');
}

function stopBackend() {
  if (pythonProcess) {
    pythonProcess.removeAllListeners();
    if (!pythonProcess.killed) {
      try {
        pythonProcess.kill();
      } catch (error) {
        // Ignore errors raised while killing the process
      }
    }
    pythonProcess = null;
    backendReady = false;
  }
}

function showStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('BettaFish 桌面应用', `无法启动后端服务：\n${message}`);
}

function startBackend() {
  if (pythonProcess) {
    return Promise.resolve();
  }

  const projectRoot = path.resolve(__dirname, '..');
  const backendScript = path.join(projectRoot, 'app.py');

  if (!fs.existsSync(backendScript)) {
    return Promise.reject(new Error(`未找到后端入口脚本：${backendScript}`));
  }

  const candidateCommands = [];
  if (process.env.PYTHON && process.env.PYTHON.trim().length > 0) {
    candidateCommands.push(process.env.PYTHON.trim());
  }
  if (process.platform === 'win32') {
    candidateCommands.push('python', 'python3');
  } else {
    candidateCommands.push('python3', 'python');
  }

  return new Promise((resolve, reject) => {
    const trySpawn = (index) => {
      if (index >= candidateCommands.length) {
        reject(new Error('无法找到可用的 Python 解释器，请确保已经安装 Python，并在必要时设置 PYTHON 环境变量。'));
        return;
      }

      const command = candidateCommands[index];
      const child = spawn(command, [backendScript], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          BETTAFISH_DESKTOP: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const handleError = (error) => {
        child.removeListener('spawn', handleSpawn);
        if (error && error.code === 'ENOENT') {
          trySpawn(index + 1);
        } else {
          reject(error);
        }
      };

      const handleSpawn = () => {
        child.removeListener('error', handleError);
        pythonProcess = child;
        backendReady = false;

        child.stdout.on('data', (data) => logBackendOutput('stdout', data));
        child.stderr.on('data', (data) => logBackendOutput('stderr', data));

        child.on('exit', (code, signal) => {
          pythonProcess = null;
          backendReady = false;
          if (!isQuitting) {
            const reason = typeof code === 'number' ? `退出代码 ${code}` : `信号 ${signal}`;
            dialog.showErrorBox('BettaFish 桌面应用', `Python 后端已意外退出（${reason}）。应用将关闭。`);
            app.quit();
          }
        });

        resolve();
      };

      child.once('error', handleError);
      child.once('spawn', handleSpawn);
    };

    trySpawn(0);
  });
}

function createMainWindow() {
  if (mainWindow) {
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(BACKEND_URL).catch((error) => {
    dialog.showErrorBox('BettaFish 桌面应用', `加载界面失败：${error.message}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function launchApplication() {
  try {
    await startBackend();
    await waitForBackendReady();
    createMainWindow();
  } catch (error) {
    showStartupError(error);
    app.quit();
  }
}



process.on('exit', () => {
  stopBackend();
});

process.on('SIGINT', () => {
  app.quit();
});

process.on('SIGTERM', () => {
  app.quit();
});
