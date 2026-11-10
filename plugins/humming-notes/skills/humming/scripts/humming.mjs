#!/usr/bin/env node
// Humming Notes: local server for the recording page, plus a small CLI for Claude.
//
//   node humming.mjs serve  [--project <dir>] [--port 4173] [--open]
//   node humming.mjs status [--port 4173]
//   node humming.mjs export <mp3|wav> [--port 4173]      (rendered by the open page)
//   node humming.mjs midi   [--project <dir>] [--out file.mid]   (no page needed)
//
// No npm dependencies. Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMidi, defaultProject, normalizeProject, GM_NAMES } from './shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';
const SF_CACHE = path.join(os.homedir(), '.cache', 'humming-notes', 'soundfonts');
const DEFAULT_PORT = 4173;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function projectDir(args) {
  return path.resolve(typeof args.project === 'string' ? args.project : path.join('humming-projects', 'default'));
}

function readProject(dir) {
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) return null;
  return normalizeProject(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function safeName(name) {
  const base = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
  return base || 'untitled';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- soundfonts

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const sfJobs = new Map();

// Download one instrument once and unpack it into <cache>/<name>/<midi>.mp3.
function ensureSoundfont(name) {
  if (!GM_NAMES.includes(name)) return Promise.reject(new Error('unknown instrument'));
  const dir = path.join(SF_CACHE, name);
  if (fs.existsSync(path.join(dir, '.done'))) return Promise.resolve(dir);
  if (!sfJobs.has(name)) {
    const job = (async () => {
      const res = await fetch(`${SF_BASE}/${name}-mp3.js`);
      if (!res.ok) throw new Error(`soundfont download failed: ${res.status}`);
      const text = await res.text();
      await fsp.mkdir(dir, { recursive: true });
      const re = /"([A-G]b?)(-?\d)":\s*"data:audio\/[a-z0-9]+;base64,([^"]+)"/g;
      let m;
      let count = 0;
      while ((m = re.exec(text))) {
        const midi = NOTE_NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
        await fsp.writeFile(path.join(dir, `${midi}.mp3`), Buffer.from(m[3], 'base64'));
        count++;
      }
      if (!count) throw new Error('soundfont file had no notes');
      await fsp.writeFile(path.join(dir, '.done'), String(count));
      return dir;
    })();
    job.catch(() => sfJobs.delete(name));
    sfJobs.set(name, job);
  }
  return sfJobs.get(name);
}

// ---------------------------------------------------------------- server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
  '.svg': 'image/svg+xml',
};

function readBody(req, limit = 400 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = body != null && !Buffer.isBuffer(body) && typeof body !== 'string';
  const data = isJson ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, {
    'Content-Type': isJson ? MIME['.json'] : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function sendFile(res, file, headers = {}) {
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...headers });
  } catch {
    send(res, 404, 'not found');
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function serve(args) {
  const dir = projectDir(args);
  const port = Number(args.port) || DEFAULT_PORT;
  const projectFile = path.join(dir, 'project.json');
  const takesDir = path.join(dir, 'takes');
  const exportsDir = path.join(dir, 'exports');
  fs.mkdirSync(takesDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  if (!fs.existsSync(projectFile)) {
    fs.writeFileSync(projectFile, JSON.stringify(defaultProject(path.basename(dir)), null, 2));
  }

  const mtime = () => fs.statSync(projectFile).mtimeMs;
  const commands = new Map(); // id -> {id, type, format, state, file, error}
  let nextCommand = 1;
  let lastPoll = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, 'forbidden');

      // --- project
      if (p === '/api/project' && req.method === 'GET') {
        let project;
        let error = null;
        try {
          project = readProject(dir);
        } catch (e) {
          error = `project.json を読めません: ${e.message}`;
        }
        return send(res, 200, { project, mtime: mtime(), error, dir });
      }
      if (p === '/api/project' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        // The file changed under the page (Claude edited it): make the page reload instead.
        if (body.baseMtime != null && body.baseMtime !== mtime()) return send(res, 409, { mtime: mtime() });
        const tmp = projectFile + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(normalizeProject(body.project), null, 2));
        await fsp.rename(tmp, projectFile);
        return send(res, 200, { mtime: mtime() });
      }
      if (p === '/api/poll' && req.method === 'GET') {
        lastPoll = Date.now();
        const pending = [...commands.values()].filter((c) => c.state === 'queued');
        for (const c of pending) c.state = 'running';
        return send(res, 200, { mtime: mtime(), commands: pending });
      }

      // --- recorded takes
      const take = p.match(/^\/takes\/([\w-]+\.wav)$/);
      if (take && req.method === 'GET') return sendFile(res, path.join(takesDir, take[1]));
      if (take && req.method === 'PUT') {
        await fsp.writeFile(path.join(takesDir, take[1]), await readBody(req));
        return send(res, 200, { file: `takes/${take[1]}` });
      }

      // --- exports
      if (p === '/api/export/midi' && req.method === 'GET') {
        const project = readProject(dir);
        const file = path.join(exportsDir, `${safeName(project.name)}-${stamp()}.mid`);
        const bytes = Buffer.from(buildMidi(project));
        await fsp.writeFile(file, bytes);
        return send(res, 200, bytes, {
          'Content-Type': MIME['.mid'],
          'X-Saved-To': encodeURIComponent(file),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        });
      }
      if (p === '/api/export' && req.method === 'PUT') {
        const ext = url.searchParams.get('format') === 'wav' ? 'wav' : 'mp3';
        const name = safeName(url.searchParams.get('name') || 'humming');
        const file = path.join(exportsDir, `${name}-${stamp()}.${ext}`);
        await fsp.writeFile(file, await readBody(req));
        const cmd = commands.get(Number(url.searchParams.get('cmd')));
        if (cmd) Object.assign(cmd, { state: 'done', file });
        console.log(`exported ${file}`);
        return send(res, 200, { file });
      }

      // --- commands from the CLI to the page
      if (p === '/api/command' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const cmd = { id: nextCommand++, type: body.type, format: body.format, state: 'queued' };
        commands.set(cmd.id, cmd);
        return send(res, 200, { ...cmd, pageOpen: Date.now() - lastPoll < 5000 });
      }
      const cmdGet = p.match(/^\/api\/command\/(\d+)$/);
      if (cmdGet && req.method === 'GET') {
        const cmd = commands.get(Number(cmdGet[1]));
        return cmd ? send(res, 200, { ...cmd, pageOpen: Date.now() - lastPoll < 5000 }) : send(res, 404, 'no such command');
      }
      if (cmdGet && req.method === 'POST') {
        const cmd = commands.get(Number(cmdGet[1]));
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        if (cmd) Object.assign(cmd, { state: 'error', error: String(body.error || 'failed') });
        return send(res, 200, {});
      }
      if (p === '/api/status' && req.method === 'GET') {
        const project = readProject(dir);
        return send(res, 200, {
          dir,
          projectFile,
          pageOpen: Date.now() - lastPoll < 5000,
          name: project.name,
          bpm: project.bpm,
          nextInstrument: project.next.instrument,
          tracks: project.tracks.map((t) => ({ id: t.id, name: t.name, instrument: t.instrument, notes: t.notes.length, mute: t.mute })),
          exports: fs.readdirSync(exportsDir),
        });
      }

      // --- instrument samples (downloaded once, then cached on disk)
      const sf = p.match(/^\/sf\/([a-z0-9_]+)\/(\d+)\.mp3$/);
      if (sf && req.method === 'GET') {
        try {
          const sfDir = await ensureSoundfont(sf[1]);
          return sendFile(res, path.join(sfDir, `${sf[2]}.mp3`), { 'Cache-Control': 'max-age=86400' });
        } catch (e) {
          return send(res, 502, String(e.message || e));
        }
      }

      // --- static files
      if (req.method === 'GET') {
        if (p === '/lib/shared.mjs') return sendFile(res, path.join(HERE, 'shared.mjs'));
        if (p === '/lib/analyze.mjs') return sendFile(res, path.join(HERE, 'analyze.mjs'));
        const rel = p === '/' ? 'index.html' : p.slice(1);
        const file = path.resolve(WEB_DIR, rel);
        if (!file.startsWith(path.resolve(WEB_DIR) + path.sep)) return send(res, 403, 'forbidden');
        return sendFile(res, file);
      }
      send(res, 404, 'not found');
    } catch (e) {
      send(res, 500, String(e && e.message ? e.message : e));
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`ポート ${port} は使用中です。すでに起動中なら http://localhost:${port}/ を開いてください。別ポートは --port で指定できます。`);
    } else console.error(e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`Humming Notes: ${url}`);
    console.log(`project: ${projectFile}`);
    if (args.open) openBrowser(url);
  });
}

// ---------------------------------------------------------------- CLI

async function api(port, pathname, init) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  } catch {
    throw new Error(`サーバーに接続できません (port ${port})。先に serve を起動してください。`);
  }
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function cliExport(args) {
  const format = args._[1];
  if (format !== 'mp3' && format !== 'wav') throw new Error('使い方: humming.mjs export <mp3|wav>');
  const port = Number(args.port) || DEFAULT_PORT;
  const cmd = await api(port, '/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'export', format }),
  });
  if (!cmd.pageOpen) console.error('ページが開かれていないようです。ブラウザでページを開くと書き出しが始まります…');
  const deadline = Date.now() + (Number(args.timeout) || 180) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await api(port, `/api/command/${cmd.id}`);
    if (s.state === 'done') return console.log(s.file);
    if (s.state === 'error') throw new Error(`書き出し失敗: ${s.error}`);
  }
  throw new Error('タイムアウト: ページが応答しません。ブラウザのタブが開いているか確認してください（ページ上の書き出しボタンでも同じファイルが作れます）。');
}

function cliMidi(args) {
  const dir = projectDir(args);
  const project = readProject(dir);
  if (!project) throw new Error(`${path.join(dir, 'project.json')} がありません`);
  const out = typeof args.out === 'string' ? path.resolve(args.out) : path.join(dir, 'exports', `${safeName(project.name)}-${stamp()}.mid`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildMidi(project));
  console.log(out);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';
  if (cmd === 'serve') return serve(args);
  if (cmd === 'midi') return cliMidi(args);
  if (cmd === 'export') return cliExport(args);
  if (cmd === 'status') return console.log(JSON.stringify(await api(Number(args.port) || DEFAULT_PORT, '/api/status'), null, 2));
  throw new Error(`unknown command: ${cmd} (serve | status | export | midi)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
