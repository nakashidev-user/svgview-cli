#!/usr/bin/env node

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT_DIR = path.join(os.homedir(), '.svgview');
const LIBRARY_DIR = path.join(ROOT_DIR, 'library');
const INDEX_PATH = path.join(ROOT_DIR, 'index.json');
const PID_PATH = path.join(ROOT_DIR, 'server.pid');
const LOG_PATH = path.join(ROOT_DIR, 'server.log');
const VIEWER_PATH = path.join(__dirname, '..', 'public', 'viewer.html');
const DEFAULT_PORT = 3899;

function printUsage() {
  console.log(`Usage:
  svgview [file.svg] [--port 4321] [--no-open] [--foreground]
  svgview --stop

Examples:
  svgview architecture.svg
  svgview
  svgview architecture.svg --port 4321
  svgview architecture.svg --no-open
  svgview architecture.svg --foreground
  svgview --stop`);
}

function parseArgs(argv) {
  const args = {
    file: null,
    port: DEFAULT_PORT,
    open: true,
    background: true,
    stop: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--no-open') {
      args.open = false;
      continue;
    }
    if (arg === '--background' || arg === '-b') {
      args.background = true;
      continue;
    }
    if (arg === '--foreground' || arg === '-f') {
      args.background = false;
      continue;
    }
    if (arg === '--stop') {
      args.stop = true;
      continue;
    }
    if (arg === '--port') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--port requires a value');
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      args.port = port;
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      args.port = port;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (args.file) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    args.file = arg;
  }

  if (args.stop && args.file) {
    throw new Error('--stop cannot be used with a file');
  }

  return args;
}

async function ensureStorage() {
  await fsp.mkdir(LIBRARY_DIR, { recursive: true });
  try {
    await fsp.access(INDEX_PATH, fs.constants.F_OK);
  } catch {
    await writeJsonAtomic(INDEX_PATH, { items: [] });
  }
}

async function readPidFile() {
  try {
    const raw = await fsp.readFile(PID_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Number.isInteger(data.pid)) {
      return null;
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read server.pid: ${error.message}`);
  }
}

async function writePidFile(data) {
  await writeJsonAtomic(PID_PATH, data);
}

async function removePidFile() {
  try {
    await fsp.unlink(PID_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

async function stopBackgroundServer() {
  await ensureStorage();
  const pidData = await readPidFile();
  if (!pidData) {
    console.log('svgview background server is not running');
    return;
  }

  if (!isProcessRunning(pidData.pid)) {
    await removePidFile();
    console.log('svgview background server was not running; removed stale pid file');
    return;
  }

  process.kill(pidData.pid, 'SIGTERM');
  console.log(`stopped svgview background server (pid ${pidData.pid})`);
}

async function startBackgroundServer(args) {
  await ensureStorage();

  const pidData = await readPidFile();
  if (pidData && isProcessRunning(pidData.pid)) {
    if (!args.file) {
      const url = pidData.url || `http://127.0.0.1:${pidData.port || args.port}/`;
      console.log(`svgview background server is already running at ${url} (pid ${pidData.pid})`);
      if (args.open) {
        openBrowser(url);
      }
      return;
    }

    console.log(`restarting svgview background server for ${args.file}`);
    process.kill(pidData.pid, 'SIGTERM');
    const stopped = await waitForProcessExit(pidData.pid);
    if (!stopped) {
      console.error(`svgview: failed to stop existing background server (pid ${pidData.pid})`);
      process.exitCode = 1;
      return;
    }
    await removePidFile();
  } else if (pidData) {
    await removePidFile();
  }

  const childArgs = process.argv.slice(1).filter((arg) => (
    arg !== '--background' &&
    arg !== '-b' &&
    arg !== '--foreground' &&
    arg !== '-f'
  ));
  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      SVGVIEW_BACKGROUND_CHILD: '1'
    },
    stdio: ['ignore', logFd, logFd]
  });

  child.unref();
  fs.closeSync(logFd);

  const url = `http://127.0.0.1:${args.port}/`;
  console.log(`svgview background server starting at ${url}`);
  console.log(`log: ${LOG_PATH}`);
}

async function readIndex() {
  await ensureStorage();
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) {
      return { items: [] };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { items: [] };
    }
    throw new Error(`Failed to read index.json: ${error.message}`);
  }
}

async function writeIndex(index) {
  await writeJsonAtomic(INDEX_PATH, index);
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, filePath);
}

function createId(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\..+$/, '');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${suffix}`;
}

async function validateSvgFile(fileArg) {
  const absolutePath = path.resolve(process.cwd(), fileArg);
  if (path.extname(absolutePath).toLowerCase() !== '.svg') {
    throw new Error('Only .svg files are supported');
  }

  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`SVG file not found: ${absolutePath}`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absolutePath}`);
  }
  return { absolutePath, stat };
}

async function addToLibrary(sourcePath, stat) {
  await ensureStorage();
  const index = await readIndex();
  const realSourcePath = await fsp.realpath(sourcePath);
  const existing = index.items.find((item) => item.sourcePath === realSourcePath);
  const now = new Date().toISOString();

  if (existing) {
    const storedAbsolutePath = path.join(ROOT_DIR, existing.storedPath);
    await fsp.copyFile(realSourcePath, storedAbsolutePath);
    existing.name = path.basename(realSourcePath);
    existing.updatedAt = now;
    existing.size = stat.size;
    delete existing.deletedAt;
    await writeIndex(index);
    return existing;
  }

  const id = createId();
  const storedFileName = `${id}.svg`;
  const storedPath = path.join('library', storedFileName);
  const storedAbsolutePath = path.join(ROOT_DIR, storedPath);
  await fsp.copyFile(realSourcePath, storedAbsolutePath);

  const item = {
    id,
    name: path.basename(realSourcePath),
    storedPath,
    sourcePath: realSourcePath,
    createdAt: now,
    updatedAt: now,
    size: stat.size
  };
  index.items.unshift(item);
  await writeIndex(index);
  return item;
}

async function deleteLibraryItem(id) {
  const index = await readIndex();
  const item = index.items.find((entry) => entry.id === id && !entry.deletedAt);
  if (!item) {
    return null;
  }
  const now = new Date().toISOString();
  item.deletedAt = now;
  item.updatedAt = now;
  await writeIndex(index);
  return item;
}

async function updateLibraryItemFromSource(sourcePath) {
  const index = await readIndex();
  const realSourcePath = await fsp.realpath(sourcePath);
  const item = index.items.find((entry) => entry.sourcePath === realSourcePath && !entry.deletedAt);
  if (!item) {
    return null;
  }
  const stat = await fsp.stat(realSourcePath);
  const storedAbsolutePath = path.join(ROOT_DIR, item.storedPath);
  await fsp.copyFile(realSourcePath, storedAbsolutePath);
  item.updatedAt = new Date().toISOString();
  item.size = stat.size;
  await writeIndex(index);
  return item;
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readSvgForCurrent(currentFile) {
  if (!currentFile) {
    return null;
  }
  return fsp.readFile(currentFile, 'utf8');
}

function createServer(state) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/') {
        const html = await fsp.readFile(VIEWER_PATH, 'utf8');
        send(res, 200, html, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/svg') {
        const svg = await readSvgForCurrent(state.currentFile);
        if (!svg) {
          send(res, 204, '', { 'Cache-Control': 'no-store' });
          return;
        }
        send(res, 200, svg, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/library') {
        const index = await readIndex();
        const currentRealPath = state.currentFile ? await fsp.realpath(state.currentFile).catch(() => state.currentFile) : null;
        const visibleItems = index.items.filter((item) => !item.deletedAt);
        const currentItem = currentRealPath
          ? visibleItems.find((item) => item.sourcePath === currentRealPath)
          : null;
        sendJson(res, 200, {
          currentId: currentItem ? currentItem.id : null,
          items: visibleItems.map((item) => ({
            id: item.id,
            name: item.name,
            storedPath: item.storedPath,
            sourcePath: item.sourcePath,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            size: item.size
          }))
        });
        return;
      }

      const libraryMatch = url.pathname.match(/^\/library\/([^/]+)$/);
      if (req.method === 'GET' && libraryMatch) {
        const id = decodeURIComponent(libraryMatch[1]);
        const index = await readIndex();
        const item = index.items.find((entry) => entry.id === id && !entry.deletedAt);
        if (!item) {
          sendError(res, 404, 'Library item not found');
          return;
        }
        const storedAbsolutePath = path.join(ROOT_DIR, item.storedPath);
        const svg = await fsp.readFile(storedAbsolutePath, 'utf8');
        send(res, 200, svg, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return;
      }

      if (req.method === 'DELETE' && libraryMatch) {
        const id = decodeURIComponent(libraryMatch[1]);
        const item = await deleteLibraryItem(id);
        if (!item) {
          sendError(res, 404, 'Library item not found');
          return;
        }
        sendJson(res, 200, { ok: true, id, deletedAt: item.deletedAt });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');
        state.clients.add(res);
        req.on('close', () => {
          state.clients.delete(res);
        });
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (error) {
      sendError(res, 500, error.message || 'Internal server error');
    }
  });
}

function broadcastReload(state, item = null) {
  const payload = JSON.stringify({
    type: 'reload',
    updatedAt: new Date().toISOString(),
    item
  });
  for (const client of state.clients) {
    client.write(`event: reload\ndata: ${payload}\n\n`);
  }
}

function watchSvg(state) {
  if (!state.currentFile) {
    return null;
  }

  let timer = null;
  const watchedDir = path.dirname(state.currentFile);
  const watchedName = path.basename(state.currentFile);
  const watcher = fs.watch(watchedDir, { persistent: true }, (_eventType, filename) => {
    if (filename && filename.toString() !== watchedName) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const item = await updateLibraryItemFromSource(state.currentFile);
        broadcastReload(state, item);
      } catch (error) {
        console.error(`Failed to process SVG change: ${error.message}`);
      }
    }, 120);
  });

  watcher.on('error', (error) => {
    console.error(`File watch error: ${error.message}`);
  });

  return watcher;
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', () => {
    console.error(`Open this URL in your browser: ${url}`);
  });
  child.unref();
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`svgview: ${error.message}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (args.stop) {
    await stopBackgroundServer();
    return;
  }

  if (args.background && process.env.SVGVIEW_BACKGROUND_CHILD !== '1') {
    await startBackgroundServer(args);
    return;
  }

  await ensureStorage();

  const state = {
    currentFile: null,
    clients: new Set()
  };

  if (args.file) {
    const { absolutePath, stat } = await validateSvgFile(args.file);
    state.currentFile = absolutePath;
    await addToLibrary(absolutePath, stat);
  }

  const server = createServer(state);
  const watcher = watchSvg(state);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`svgview: port ${args.port} is already in use`);
    } else {
      console.error(`svgview: server error: ${error.message}`);
    }
    if (process.env.SVGVIEW_BACKGROUND_CHILD === '1') {
      removePidFile().catch(() => {});
    }
    process.exit(1);
  });

  server.listen(args.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${args.port}/`;
    if (process.env.SVGVIEW_BACKGROUND_CHILD === '1') {
      writePidFile({
        pid: process.pid,
        url,
        port: args.port,
        file: state.currentFile,
        startedAt: new Date().toISOString()
      }).catch((error) => {
        console.error(`Failed to write pid file: ${error.message}`);
      });
    }
    console.log(`svgview running at ${url}`);
    if (state.currentFile) {
      console.log(`previewing ${state.currentFile}`);
    } else {
      console.log('showing library');
    }
    if (args.open) {
      openBrowser(url);
    }
  });

  const shutdown = async () => {
    if (watcher) {
      watcher.close();
    }
    for (const client of state.clients) {
      client.end();
    }
    if (process.env.SVGVIEW_BACKGROUND_CHILD === '1') {
      await removePidFile().catch(() => {});
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`svgview: ${error.message}`);
  process.exit(1);
});
