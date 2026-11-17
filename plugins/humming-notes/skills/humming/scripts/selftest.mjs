// Self-test: synthesize a hummed melody, run the analyzer, check the notes and the MIDI writer.
// Run: node selftest.mjs
import { analyzeTake, measureLatency, measureClickLag } from './analyze.mjs';
import { buildMidi, normalizeProject, effectiveNotes } from './shared.mjs';
import { MESSAGES, LANGS, pickLang, translator } from './i18n.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SR = 48000;
function hum(melody, { detune = 0, vibrato = 0.2, noise = 0.01, breathy = false } = {}) {
  const total = melody.reduce((m, n) => Math.max(m, n.t + n.d), 0) + 0.5;
  const out = new Float32Array(Math.round(total * SR));
  for (const n of melody) {
    let phase = 0;
    const len = Math.round(n.d * SR);
    const base = Math.round(n.t * SR);
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      const midi = n.p + detune + vibrato * Math.sin(2 * Math.PI * 5.5 * tt);
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      phase += (2 * Math.PI * f) / SR;
      const env = Math.min(1, tt / 0.03, (n.d - tt) / 0.04);
      // A breathy dropout: the tone turns to noise for 50 ms but stays loud.
      if (breathy && tt > n.d / 2 && tt < n.d / 2 + 0.05) {
        out[base + i] += 0.25 * (Math.random() * 2 - 1);
        continue;
      }
      out[base + i] += 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * (Math.random() * 2 - 1);
  return out;
}

let failed = 0;
function check(name, melody, opts, expected = melody.map((n) => n.p)) {
  const { notes, detuneCents } = analyzeTake(hum(melody, opts), SR, opts);
  const ok =
    notes.length === melody.length &&
    notes.every((n, i) => n.p === expected[i] && Math.abs(n.t - melody[i].t) < 0.06 && Math.abs(n.d - melody[i].d) < 0.1);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (detune ${detuneCents}c)`);
  if (!ok) {
    failed++;
    console.log('  expected', JSON.stringify(melody));
    console.log('  got     ', JSON.stringify(notes));
  }
}

const twinkle = [60, 60, 67, 67, 69, 69, 67].map((p, i) => ({ t: 0.3 + i * 0.5, d: i === 6 ? 0.9 : 0.4, p }));
check('separated notes', twinkle);
check('sung 30 cents flat', twinkle, { detune: -0.3 });
check('legato scale', [57, 59, 60, 62, 64].map((p, i) => ({ t: 0.2 + i * 0.4, d: 0.4, p })), { vibrato: 0.1 });
check('low male voice', [43, 45, 47, 48].map((p, i) => ({ t: 0.2 + i * 0.6, d: 0.5, p })));
check('high whistle range', [79, 81, 83, 84].map((p, i) => ({ t: 0.2 + i * 0.3, d: 0.25, p })), { vibrato: 0.05 });
check('fast notes', [64, 62, 60, 62, 64, 64, 64].map((p, i) => ({ t: 0.2 + i * 0.2, d: 0.14, p })), { vibrato: 0 });

const sloppy = [60, 62, 63.4, 65, 67, 65, 63.6, 62, 60].map((p, i) => ({ t: 0.2 + i * 0.45, d: 0.35, p }));
check('off-pitch notes pulled onto the key', sloppy, { vibrato: 0.05 }, [60, 62, 64, 65, 67, 65, 64, 62, 60]);
check('same take without key snapping', sloppy, { vibrato: 0.05, snapToScale: false }, [60, 62, 63, 65, 67, 65, 64, 62, 60]);
check('breathy dropouts do not split notes', [60, 64, 67].map((p, i) => ({ t: 0.2 + i * 0.7, d: 0.6, p })), { breathy: true });

const silent = analyzeTake(new Float32Array(SR * 2).map(() => 0.002 * (Math.random() * 2 - 1)), SR);
console.log(`${silent.notes.length === 0 ? 'ok  ' : 'FAIL'} silence gives no notes`);
if (silent.notes.length) failed++;

const project = normalizeProject({ bpm: 120, tracks: [{ instrument: 'flute', quantize: 2, notes: [{ t: 0.03, d: 0.22, p: 60 }, { t: 0.27, d: 0.5, p: 62 }] }] });
const eff = effectiveNotes(project, project.tracks[0]);
const midi = buildMidi(project);
const midiOk = eff[0].t === 0 && eff[0].d === 0.25 && eff[1].t === 0.25 && String.fromCharCode(...midi.slice(0, 4)) === 'MThd' && midi[11] === 2;
console.log(`${midiOk ? 'ok  ' : 'FAIL'} quantize + MIDI header`);
if (!midiOk) failed++;

// Latency: two takes sung to a 120 bpm click, both recorded 80 ms late with human jitter.
{
  const jitter = () => (Math.random() - 0.5) * 0.04;
  const beats1 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 4.5, 5, 6];
  const beats2 = [0, 0.25, 0.5, 1, 2, 2.25, 2.5, 3, 4, 5, 5.5, 6];
  const late = (arr, ms) => arr.map((t) => t + ms / 1000 + jitter());
  const grid = measureLatency(120, { onsets: late(beats1, 80), click: true }, { onsets: late(beats2, 80), click: true });
  const gridOk = grid && grid.method === 'grid' && Math.abs(grid.lag - 0.08) < 0.02;
  console.log(`${gridOk ? 'ok  ' : 'FAIL'} latency against the metronome (${grid ? Math.round(grid.lag * 1000) : '?'} ms, expected 80)`);
  if (!gridOk) failed++;

  // No click: free rhythm, second take follows the first 120 ms late.
  const free = [0.13, 0.61, 0.98, 1.72, 2.2, 2.71, 3.4, 3.83, 4.6, 5.12];
  const pair = measureLatency(120, { onsets: free, click: false }, { onsets: late(free, 120), click: false });
  const pairOk = pair && pair.method === 'pair' && Math.abs(pair.lag - 0.12) < 0.02;
  console.log(`${pairOk ? 'ok  ' : 'FAIL'} latency against the first take (${pair ? Math.round(pair.lag * 1000) : '?'} ms, expected 120)`);
  if (!pairOk) failed++;

  const none = measureLatency(120, { onsets: [0.1, 0.9, 2.3], click: false }, { onsets: [0.4, 1.7], click: false });
  console.log(`${none === null ? 'ok  ' : 'FAIL'} too few notes gives no latency estimate`);
  if (none !== null) failed++;
}

// Click calibration: eight short "ah"s, each 130 ms after its click, with human jitter.
{
  const clicks = Array.from({ length: 12 }, (_, k) => 0.5 + k * 0.6);
  const rec = new Float32Array(Math.round(SR * 9));
  for (const c of clicks.slice(4)) {
    const start = Math.round((c + 0.13 + (Math.random() - 0.5) * 0.03) * SR);
    let ph = 0;
    for (let i = 0; i < SR * 0.18; i++) {
      ph += (2 * Math.PI * 180) / SR;
      rec[start + i] += 0.3 * Math.min(1, i / (SR * 0.01), (SR * 0.18 - i) / (SR * 0.03)) * (Math.sin(ph) + 0.4 * Math.sin(2 * ph));
    }
  }
  for (let i = 0; i < rec.length; i++) rec[i] += 0.004 * (Math.random() * 2 - 1);
  const r = measureClickLag(rec, SR, clicks);
  const ok = r && Math.abs(r.lag - 0.13) < 0.02 && r.matched === 8;
  console.log(`${ok ? 'ok  ' : 'FAIL'} click calibration (${r ? Math.round(r.lag * 1000) : '?'} ms, expected 130)`);
  if (!ok) failed++;
  const quiet = measureClickLag(new Float32Array(SR * 9).map(() => 0.002 * (Math.random() * 2 - 1)), SR, clicks);
  console.log(`${quiet === null ? 'ok  ' : 'FAIL'} click calibration with no voice gives no result`);
  if (quiet !== null) failed++;
}

// Translations: every language has the same keys and placeholders as English,
// and every key the page or the CLI asks for exists.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const expect = (ok, name, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} i18n: ${name}${ok || !detail ? '' : ` (${detail})`}`);
    if (!ok) failed++;
  };
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const [lang] of LANGS) {
    if (lang === 'en') continue;
    const missing = Object.keys(MESSAGES.en).filter((k) => !(k in MESSAGES[lang]));
    const extra = Object.keys(MESSAGES[lang]).filter((k) => !(k in MESSAGES.en));
    const mismatched = Object.keys(MESSAGES[lang]).filter((k) => k in MESSAGES.en && holes(MESSAGES[lang][k]) !== holes(MESSAGES.en[k]));
    expect(!missing.length && !extra.length, `${lang} has the same keys as en`, [...missing, ...extra].join(', '));
    expect(!mismatched.length, `${lang} uses the same placeholders as en`, mismatched.join(', '));
  }
  const used = new Set();
  const app = fs.readFileSync(path.join(here, '..', 'web', 'app.js'), 'utf8');
  const cli = fs.readFileSync(path.join(here, 'humming.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(here, '..', 'web', 'index.html'), 'utf8');
  for (const m of (app + cli).matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  // Keys chosen by a condition: t(late ? 'cal.fixedLate' : 'cal.fixedEarly', ...)
  for (const m of (app + cli).matchAll(/\? '([a-z]\w*\.\w+)' : '([a-z]\w*\.\w+)'/g)) used.add(m[1]).add(m[2]);
  for (const m of html.matchAll(/data-i18n(?:-title)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of cli.matchAll(/code: '(\w+)'/g)) used.add(`err.${m[1]}`);
  const unknown = [...used].filter((k) => !(k in MESSAGES.en));
  expect(used.size > 100 && !unknown.length, 'every key in the page and the CLI is defined', unknown.join(', '));
  const unused = Object.keys(MESSAGES.en).filter((k) => !used.has(k) && !/^(inst|sf|quant)\./.test(k));
  expect(!unused.length, 'no unused keys', unused.join(', '));
  expect(/[ぁ-んァ-ヶ一-龠]/.test(app + cli + html) === false, 'no Japanese text outside i18n.mjs');
  const ja = translator('ja');
  expect(
    pickLang(null, 'ja-JP') === 'ja' && pickLang('fr', 'en-US', 'ja') === 'en' && pickLang() === 'en' && translator('fr').lang === 'en',
    'language choice falls back to English'
  );
  expect(ja('err.song_exists', { folder: 'x' }).includes('「x」') && translator('en')('rec.done', { count: 3, tuning: '' }).includes('3 notes'), 'placeholders are filled');
}

// Song management: a real server in a scratch folder, driven the way the page drives it.
{
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'humming.mjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'humming-selftest-'));
  const port = 4300 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [script, 'serve', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  const expect = (ok, name, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} songs: ${name}${ok || !detail ? '' : ` (${detail})`}`);
    if (!ok) failed++;
  };
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => String(d).includes('Humming Notes') && resolve());
      server.on('exit', () => reject(new Error('server exited')));
      setTimeout(() => reject(new Error('server did not start')), 10000);
    });
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (body) => {
      const res = await fetch(`${base}/api/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, ...(await res.json()) };
    };
    const songs = async () => (await get('/api/songs')).songs.map((s) => s.folder).sort().join(',');
    const root = path.join(cwd, 'humming-projects');
    const cli = (...a) => execFileSync(process.execPath, [script, ...a], { cwd, encoding: 'utf8' });

    expect((await songs()) === 'default', 'starts with the default song');

    // Give the default song a recording and a track, as the page would.
    await fetch(`${base}/takes/t1.wav`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    const first = await get('/api/project');
    first.project.tracks.push({ id: 't1', name: 'a', instrument: 'flute', take: 'takes/t1.wav', notes: [{ t: 0, d: 0.5, p: 60 }] });
    const put = (body) => fetch(`${base}/api/project`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ project: first.project, baseMtime: first.mtime, dir: first.dir })).status === 200, 'page save');

    const made = await post({ action: 'new', name: 'second song' });
    const second = await get('/api/project');
    expect(made.status === 200 && second.project.name === 'second song' && second.project.tracks.length === 0, 'new song is empty and open');
    expect((await songs()) === 'default,second song', 'new song is listed');
    expect((await post({ action: 'new', name: 'default' })).status === 409, 'existing name is refused');
    expect((await post({ action: 'new', name: ' .. ' })).status === 400, 'empty name is refused');
    expect(fs.readdirSync(cwd).join(',') === 'humming-projects', 'nothing is written outside the songs folder');

    // A page still showing the first song must not overwrite the second one.
    expect((await put({ project: first.project, dir: first.dir })).status === 409, 'save from a stale page is refused');
    expect(cli('midi', '--out', path.join(cwd, 'x.mid')).trim().endsWith('x.mid') === true, 'CLI runs without --project');
    expect(JSON.parse(cli('status', '--port', String(port))).dir === path.join(root, 'second song'), 'status reports the open song');

    await post({ action: 'open', folder: 'default' });
    const copied = await post({ action: 'copy', name: 'a/copy' });
    const copy = await get('/api/project');
    expect(
      copied.current === 'a_copy' && copy.project.name === 'a/copy' && copy.project.tracks.length === 1 && fs.existsSync(path.join(root, 'a_copy', 'takes', 't1.wav')),
      'copy keeps tracks and recordings',
      JSON.stringify(copied)
    );
    expect(fs.existsSync(path.join(root, 'default', 'takes', 't1.wav')), 'copy leaves the original alone');

    const renamed = await post({ action: 'rename', name: 'renamed' });
    const after = await get('/api/project');
    expect(
      renamed.status === 200 && after.project.name === 'renamed' && after.project.tracks.length === 1 && !fs.existsSync(path.join(root, 'a_copy')) && fs.existsSync(path.join(root, 'renamed', 'takes', 't1.wav')),
      'rename moves the folder with its recordings',
      JSON.stringify(renamed)
    );
    expect((await songs()) === 'default,renamed,second song', 'list after copy and rename');
    expect((await post({ action: 'open', folder: '../x' })).status === 404, 'unknown song is refused');
    expect(fs.readFileSync(path.join(root, '.current'), 'utf8') === 'renamed', 'last opened song is remembered');
  } catch (e) {
    expect(false, 'server test', e.message);
  } finally {
    server.kill();
    await new Promise((r) => (server.exitCode != null ? r() : server.on('exit', r)));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
