#!/usr/bin/env node
// Humming Notes: local server for the recording page, plus a small CLI for Claude.
//
//   node humming.mjs serve  [--project <dir>] [--port 4173] [--open]
//       Without --project, every command uses the song last opened in humming-projects/
//       (the page can create and switch songs), or humming-projects/default.
//   node humming.mjs status [--port 4173]
//   node humming.mjs export <mp3|wav> [--port 4173]      (rendered by the open page)
//   node humming.mjs midi   [--project <dir>] [--out file.mid]   (no page needed)
//   node humming.mjs curve     [--track <id|number|name>] [--project <dir>] [--from sec] [--to sec]
//   node humming.mjs set-notes --track <id|number|name> --notes <file.json> [--instrument <name>] [--project <dir>]
//   node humming.mjs latency   [--apply] [--project <dir>]
//   node humming.mjs restore   --track <id|number|name> [--project <dir>]
//
// Messages are English, or Japanese on a Japanese system. HUMMING_LANG=en|ja or --lang en|ja overrides.
//
// No npm dependencies. Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMidi, defaultProject, normalizeProject, GM_NAMES, SOUNDFONTS } from './shared.mjs';
import { trackPitch, analyzeTake, measureLatency } from './analyze.mjs';
import { pickLang, translator } from './i18n.mjs';

let t = translator(pickLang(process.env.HUMMING_LANG, Intl.DateTimeFormat().resolvedOptions().locale));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts';
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

const SONGS_ROOT = 'humming-projects';
const CURRENT_FILE = '.current'; // inside SONGS_ROOT: folder name of the song opened last

function projectDir(args) {
  if (typeof args.project === 'string') return path.resolve(args.project);
  // The page can switch songs, so follow the one opened last.
  let name = 'default';
  try {
    const cur = fs.readFileSync(path.join(SONGS_ROOT, CURRENT_FILE), 'utf8').trim();
    if (cur && cur === folderName(cur) && fs.existsSync(path.join(SONGS_ROOT, cur, 'project.json'))) name = cur;
  } catch {
    /* nothing opened here yet */
  }
  return path.resolve(SONGS_ROOT, name);
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

// A song name as a folder name. Windows drops trailing dots and spaces, so do it up front.
function folderName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
}

// Songs are the folders next to the open one that hold a project.json.
function listSongs(root) {
  const songs = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, 'project.json');
    if (!fs.existsSync(file)) continue;
    let name = e.name;
    let tracks = 0;
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof p.name === 'string' && p.name) name = p.name;
      if (Array.isArray(p.tracks)) tracks = p.tracks.length;
    } catch {
      /* listed anyway; opening it reports the problem */
    }
    songs.push({ folder: e.name, name, tracks });
  }
  return songs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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
function ensureSoundfont(set, name) {
  if (!SOUNDFONTS.some(([n]) => n === set)) return Promise.reject(new Error('unknown sound set'));
  if (!GM_NAMES.includes(name)) return Promise.reject(new Error('unknown instrument'));
  const dir = path.join(SF_CACHE, set, name);
  const key = `${set}/${name}`;
  if (fs.existsSync(path.join(dir, '.done'))) return Promise.resolve(dir);
  if (!sfJobs.has(key)) {
    const job = (async () => {
      const res = await fetch(`${SF_BASE}/${set}/${name}-mp3.js`);
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
    job.catch(() => sfJobs.delete(key));
    sfJobs.set(key, job);
  }
  return sfJobs.get(key);
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
  const port = Number(args.port) || DEFAULT_PORT;
  const root = path.dirname(projectDir(args));
  let dir;
  let projectFile;
  let takesDir;
  let exportsDir;
  // The page can switch songs, so the open folder changes while the server runs.
  function openSong(next, name = path.basename(next)) {
    dir = next;
    projectFile = path.join(dir, 'project.json');
    takesDir = path.join(dir, 'takes');
    exportsDir = path.join(dir, 'exports');
    fs.mkdirSync(takesDir, { recursive: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    if (!fs.existsSync(projectFile)) fs.writeFileSync(projectFile, JSON.stringify(defaultProject(name), null, 2));
    // Let later CLI calls without --project find this song.
    if (root === path.resolve(SONGS_ROOT)) fs.writeFileSync(path.join(root, CURRENT_FILE), path.basename(dir));
  }
  openSong(projectDir(args));

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
          error = { code: 'project_unreadable', error: `Cannot read project.json: ${e.message}`, detail: e.message };
        }
        return send(res, 200, { project, mtime: mtime(), ...error, dir });
      }
      if (p === '/api/project' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        // The file changed under the page (Claude edited it): make the page reload instead.
        // The same goes for a page that still shows a song another tab switched away from.
        const stale = (body.dir != null && body.dir !== dir) || (body.baseMtime != null && body.baseMtime !== mtime());
        if (stale) return send(res, 409, { mtime: mtime() });
        const tmp = projectFile + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(normalizeProject(body.project), null, 2));
        await fsp.rename(tmp, projectFile);
        return send(res, 200, { mtime: mtime() });
      }
      if (p === '/api/poll' && req.method === 'GET') {
        lastPoll = Date.now();
        const pending = [...commands.values()].filter((c) => c.state === 'queued');
        for (const c of pending) c.state = 'running';
        return send(res, 200, { mtime: mtime(), dir, commands: pending });
      }

      // --- songs: the folders next to the open one
      if (p === '/api/songs' && req.method === 'GET') {
        return send(res, 200, { root, current: path.basename(dir), songs: listSongs(root) });
      }
      if (p === '/api/songs' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        if (body.action === 'open') {
          const song = listSongs(root).find((s) => s.folder === body.folder);
          if (!song) return send(res, 404, { code: 'song_not_found', error: 'That song was not found.' });
          openSong(path.join(root, song.folder));
        } else if (['new', 'copy', 'rename'].includes(body.action)) {
          const name = String(body.name || '').trim();
          const folder = folderName(name);
          if (!folder) return send(res, 400, { code: 'name_required', error: 'Enter a name for the song.' });
          const target = path.join(root, folder);
          const inPlace = target === dir; // rename where only the title differs from the folder
          if (fs.existsSync(target) && !(body.action === 'rename' && inPlace)) {
            return send(res, 409, { code: 'song_exists', error: `There is already a song called "${folder}".`, folder });
          }
          if (body.action === 'new') {
            openSong(target, name);
          } else {
            const project = readProject(dir);
            if (body.action === 'copy') {
              await fsp.mkdir(target);
              // Recordings come along; exports and backups stay with the original.
              await fsp.cp(takesDir, path.join(target, 'takes'), { recursive: true });
            } else if (!inPlace) {
              await fsp.rename(dir, target);
            }
            writeProject(target, { ...project, name });
            openSong(target);
          }
        } else return send(res, 400, { error: 'unknown action' });
        console.log(`project: ${projectFile}`);
        return send(res, 200, { current: path.basename(dir), dir });
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
          draft: project.draft,
          latencyMs: project.latencyMs,
          tracks: project.tracks.map((t) => ({
            id: t.id,
            name: t.name,
            instrument: t.instrument,
            planned: t.planned,
            notes: t.notes.length,
            hasTake: !!t.take,
            cleaned: !!t.original,
            offsetMs: t.offsetMs,
            mute: t.mute,
          })),
          exports: fs.readdirSync(exportsDir),
        });
      }

      // --- instrument samples (downloaded once, then cached on disk)
      const sf = p.match(/^\/sf\/([A-Za-z0-9_]+)\/([a-z0-9_]+)\/(\d+)\.mp3$/);
      if (sf && req.method === 'GET') {
        try {
          const sfDir = await ensureSoundfont(sf[1], sf[2]);
          return sendFile(res, path.join(sfDir, `${sf[3]}.mp3`), { 'Cache-Control': 'max-age=86400' });
        } catch (e) {
          return send(res, 502, String(e.message || e));
        }
      }

      // --- static files
      if (req.method === 'GET') {
        if (p === '/lib/shared.mjs') return sendFile(res, path.join(HERE, 'shared.mjs'));
        if (p === '/lib/analyze.mjs') return sendFile(res, path.join(HERE, 'analyze.mjs'));
        if (p === '/lib/i18n.mjs') return sendFile(res, path.join(HERE, 'i18n.mjs'));
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
      console.error(t('cli.portInUse', { port }));
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
    throw new Error(t('cli.noServer', { port }));
  }
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function cliExport(args) {
  const format = args._[1];
  if (format !== 'mp3' && format !== 'wav') throw new Error(t('cli.exportUsage'));
  const port = Number(args.port) || DEFAULT_PORT;
  const cmd = await api(port, '/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'export', format }),
  });
  if (!cmd.pageOpen) console.error(t('cli.pageClosed'));
  const deadline = Date.now() + (Number(args.timeout) || 180) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await api(port, `/api/command/${cmd.id}`);
    if (s.state === 'done') return console.log(s.file);
    if (s.state === 'error') throw new Error(t('cli.exportFailed', { detail: s.error }));
  }
  throw new Error(t('cli.exportTimeout'));
}

function cliMidi(args) {
  const dir = projectDir(args);
  const project = readProject(dir);
  if (!project) throw new Error(t('cli.noProject', { file: path.join(dir, 'project.json') }));
  const out = typeof args.out === 'string' ? path.resolve(args.out) : path.join(dir, 'exports', `${safeName(project.name)}-${stamp()}.mid`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildMidi(project));
  console.log(out);
}

// ---------------------------------------------------------------- clean-up support

function findTrack(project, sel) {
  if (typeof sel !== 'string') throw new Error(t('cli.trackRequired'));
  const byId = project.tracks.find((tr) => tr.id === sel);
  const byIndex = /^\d+$/.test(sel) ? project.tracks[Number(sel) - 1] : null;
  const byName = project.tracks.find((tr) => tr.name === sel);
  const track = byId || byIndex || byName;
  if (!track) throw new Error(t('cli.noTrack', { sel, list: project.tracks.map((tr, i) => `${i + 1}=${tr.id}(${tr.name})`).join(', ') }));
  return track;
}

function loadProjectOrFail(args) {
  const dir = projectDir(args);
  const project = readProject(dir);
  if (!project) throw new Error(t('cli.noProject', { file: path.join(dir, 'project.json') }));
  return { dir, project };
}

function writeProject(dir, project) {
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(normalizeProject(project), null, 2));
  fs.renameSync(file + '.tmp', file);
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(t('cli.notWav'));
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error(t('cli.wav16'));
      const n = Math.floor(Math.min(size, buf.length - pos - 8) / 2 / fmt.channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(pos + 8 + i * 2 * fmt.channels) / 32768;
      return { samples, sampleRate: fmt.sampleRate };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error(t('cli.wavEmpty'));
}

const fmtNotes = (notes) => notes.map((n) => `${n.t.toFixed(2)}:${n.p}/${n.d.toFixed(2)}`).join('  ');

// Print what the singer actually did, compactly enough for Claude to read.
// All times are project time (the track's offsetMs already applied).
function curveText(dir, project, track, from, to) {
  const { samples, sampleRate } = readWav(path.join(dir, track.take));
  const { hopSec, count, pitch, rms, detune } = trackPitch(samples, sampleRate);
  const auto = analyzeTake(samples, sampleRate, { snapToScale: false });
  const off = track.offsetMs / 1000;
  const shifted = (notes) => notes.map((n) => ({ ...n, t: n.t + off }));
  const STEP = 3; // frames per printed value (30 ms)
  const PER_LINE = 10;
  let maxRms = 0;
  for (let i = 0; i < count; i++) maxRms = Math.max(maxRms, rms[i]);

  const out = [];
  const planned = track.planned ? t('curve.planned', { name: track.planned }) : '';
  out.push(`===== track ${track.id} "${track.name}" (${track.instrument})${planned}  transpose ${track.transpose}  offsetMs ${track.offsetMs}`);
  out.push(t('curve.take', { sec: (count * hopSec).toFixed(2), cents: Math.round(detune * 100), key: auto.key ? auto.key.name : t('cli.unknown') }));
  out.push(t('curve.notes', { notes: fmtNotes(shifted(track.notes)) || t('cli.none') }));
  if (track.original) out.push(t('curve.original', { notes: fmtNotes(shifted(track.original)) }));

  // Phrases: voiced stretches separated by >= 150 ms without pitch.
  const phrases = [];
  let start = -1;
  let lastVoiced = -1;
  for (let i = 0; i < count; i++) {
    if (!pitch[i]) continue;
    if (start < 0) start = i;
    else if (i - lastVoiced > 15) {
      phrases.push([start, lastVoiced + 1]);
      start = i;
    }
    lastVoiced = i;
  }
  if (start >= 0) phrases.push([start, lastVoiced + 1]);
  if (!phrases.length) out.push(t('curve.noPitch'));

  for (const [a, b] of phrases) {
    if (b * hopSec + off < from || a * hopSec + off > to) continue;
    out.push(`[${(a * hopSec + off).toFixed(2)}–${(b * hopSec + off).toFixed(2)}s]`);
    let line = [];
    let lineStart = a;
    for (let i = a; i < b; i += STEP) {
      const vals = [];
      let lv = 0;
      for (let k = i; k < Math.min(b, i + STEP); k++) {
        if (pitch[k]) vals.push(pitch[k] - detune);
        lv = Math.max(lv, rms[k]);
      }
      vals.sort((x, y) => x - y);
      const level = Math.min(9, Math.round((lv / (maxRms || 1)) * 9));
      line.push(vals.length ? `${vals[vals.length >> 1].toFixed(1)}/${level}` : ` .  /${level}`);
      if (line.length === PER_LINE || i + STEP >= b) {
        out.push(`  ${(lineStart * hopSec + off).toFixed(2).padStart(6)}  ${line.join(' ')}`);
        line = [];
        lineStart = i + STEP;
      }
    }
  }
  return out.join('\n');
}

function cliCurve(args) {
  const { dir, project } = loadProjectOrFail(args);
  const withTake = project.tracks.filter((tr) => tr.take);
  const tracks = typeof args.track === 'string' ? [findTrack(project, args.track)] : withTake;
  if (!tracks.length) throw new Error(t('curve.noTakes'));
  for (const tr of tracks) if (!tr.take) throw new Error(t('curve.noTake', { name: tr.name }));
  const from = Number(args.from) || 0;
  const to = args.to != null ? Number(args.to) : Infinity;
  const beat = 60 / project.bpm;
  const out = [];
  out.push(t('curve.head1', { bpm: project.bpm, beat: beat.toFixed(3), bar: (beat * project.beatsPerBar).toFixed(3), beats: project.beatsPerBar, latency: project.latencyMs }));
  out.push(t('curve.head2'));
  out.push(t('curve.head3'));
  out.push(t('curve.head4'));
  for (const tr of tracks) out.push('', curveText(dir, project, tr, from, to));
  console.log(out.join('\n'));
}

function cliSetNotes(args) {
  const { dir, project } = loadProjectOrFail(args);
  const track = findTrack(project, args.track);
  if (typeof args.notes !== 'string') throw new Error(t('set.notesRequired'));
  const parsed = JSON.parse(fs.readFileSync(path.resolve(args.notes), 'utf8'));
  const input = Array.isArray(parsed) ? parsed : parsed.notes;
  if (!Array.isArray(input) || !input.length) throw new Error(t('set.empty'));
  for (const n of input) {
    if (![n.t, n.d, n.p].every((x) => typeof x === 'number' && isFinite(x)) || n.d <= 0 || n.t < 0 || n.p < 0 || n.p > 127) {
      throw new Error(t('set.badNote', { note: JSON.stringify(n) }));
    }
  }
  if (typeof args.instrument === 'string' && args.instrument !== 'voice' && !GM_NAMES.includes(args.instrument)) {
    throw new Error(t('set.badInstrument', { name: args.instrument }));
  }
  // Input is in project time; notes are stored relative to the take.
  const off = track.offsetMs / 1000;
  const notes = input.map((n) => ({ ...n, t: Math.max(0, Math.round((n.t - off) * 1000) / 1000) }));
  // Keep the pre-clean-up notes once, so the page can flip back to them.
  if (!track.original) track.original = track.notes;
  track.notes = notes;
  track.quantize = 0;
  let inst = '';
  if (typeof args.instrument === 'string') {
    track.instrument = args.instrument;
    track.planned = null;
    inst = t('set.instrument', { name: args.instrument });
  }
  writeProject(dir, project);
  console.log(t('set.done', { track: track.name, before: track.original.length, after: notes.length, inst }));
}

function cliRestore(args) {
  const { dir, project } = loadProjectOrFail(args);
  const track = findTrack(project, args.track);
  if (!track.original) throw new Error(t('restore.none'));
  track.notes = track.original;
  track.original = null;
  writeProject(dir, project);
  console.log(t('restore.done', { track: track.name, count: track.notes.length }));
}

// Compare the first two recordings and report how far the overdub is off.
function cliLatency(args) {
  const { dir, project } = loadProjectOrFail(args);
  const takes = project.tracks.filter((tr) => tr.take).slice(0, 2);
  if (takes.length < 2) throw new Error(t('lat.needTwo'));
  const sides = takes.map((tr) => {
    const { samples, sampleRate } = readWav(path.join(dir, tr.take));
    const { notes } = analyzeTake(samples, sampleRate, { snapToScale: false });
    return { onsets: notes.map((n) => n.t + tr.offsetMs / 1000), click: tr.click ?? project.metronome };
  });
  const r = measureLatency(project.bpm, sides[0], sides[1]);
  if (!r) {
    console.log(t('lat.failed'));
    return;
  }
  const ms = Math.round(r.lag * 1000);
  const how = r.method === 'grid' ? t('lat.howGrid') : t('lat.howPair', { a: takes[0].name, b: takes[1].name });
  console.log(t('lat.result', { ms: `${ms >= 0 ? '+' : ''}${ms}`, how, matched: r.matched, spread: Math.round(r.spread * 1000) }));
  if (!args.apply) return console.log(t('lat.applyHint'));
  if (Math.abs(ms) < 10) return console.log(t('lat.tooSmall'));
  project.latencyMs += ms;
  const targets = r.method === 'grid' ? takes : [takes[1]];
  for (const tr of targets) if (!tr.original) tr.offsetMs -= ms;
  project.latencyCalibrated = true;
  writeProject(dir, project);
  console.log(t('lat.applied', { latency: project.latencyMs, tracks: targets.filter((tr) => !tr.original).map((tr) => tr.name).join(', ') || t('lat.noTracks') }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.lang === 'string') t = translator(pickLang(args.lang));
  const cmd = args._[0] || 'serve';
  if (cmd === 'serve') return serve(args);
  if (cmd === 'midi') return cliMidi(args);
  if (cmd === 'export') return cliExport(args);
  if (cmd === 'curve') return cliCurve(args);
  if (cmd === 'set-notes') return cliSetNotes(args);
  if (cmd === 'restore') return cliRestore(args);
  if (cmd === 'latency') return cliLatency(args);
  if (cmd === 'status') return console.log(JSON.stringify(await api(Number(args.port) || DEFAULT_PORT, '/api/status'), null, 2));
  throw new Error(`unknown command: ${cmd} (serve | status | export | midi | curve | set-notes | restore | latency)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
