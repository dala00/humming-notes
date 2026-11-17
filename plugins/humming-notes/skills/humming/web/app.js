import {
  SOUNDFONTS,
  INSTRUMENT_CHOICES,
  instrumentLabel,
  isKnownInstrument,
  normalizeProject,
  effectiveNotes,
  songDuration,
} from '/lib/shared.mjs';
import { analyzeTake, measureLatency, measureClickLag } from '/lib/analyze.mjs';

const $ = (id) => document.getElementById(id);
const COLORS = ['#5ab0ff', '#ff8a5a', '#7fd88f', '#e07be0', '#ffd24d', '#5ad8d0', '#ff6b8b', '#a59bff'];
const EXPORT_RATE = 44100;
const MASTER_GAIN = 1.6;
const REVERB_GAIN = 4;

let project = null;
let baseMtime = null;
let songDir = null; // folder the loaded project came from
let saveTimer = null;
let saving = null;
let mode = 'idle'; // idle | playing | recording | busy
let cursor = 0; // where play / record starts, seconds
let selectedTrack = null;
let selectedNote = null; // index into track.notes
const undoStack = [];

let ctx = null;
let master = null;
let mic = null; // { stream, source, node, analyser, levelBuf }
let session = null; // current playback or recording
const decodeCtx = new OfflineAudioContext(2, 1, EXPORT_RATE);
const samples = new Map(); // "instrument/midi" -> AudioBuffer | null
const sampleJobs = new Map();
const failedInstruments = new Set();
const takes = new Map(); // track id -> AudioBuffer
const view = { start: 0, pxPerSec: 90 };

// ------------------------------------------------------------------ helpers

function status(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

const beatSec = () => 60 / project.bpm;
const trackById = (id) => project.tracks.find((t) => t.id === id);
const colorOf = (track) => COLORS[project.tracks.indexOf(track) % COLORS.length];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function takeDurations() {
  const out = {};
  for (const [id, buf] of takes) out[id] = buf.duration;
  return out;
}
const duration = () => songDuration(project, takeDurations());

// ------------------------------------------------------------------ project sync

async function loadProject() {
  const res = await fetch('/api/project');
  const json = await res.json();
  if (json.error) {
    status(json.error, 'error');
    if (!project) project = normalizeProject({});
  } else {
    project = normalizeProject(json.project);
  }
  // Another tab (or the server restarting elsewhere) switched songs: start over with that song.
  if (songDir != null && json.dir !== songDir) return location.reload();
  songDir = json.dir;
  baseMtime = json.mtime;
  loadSongs();
  $('projectPath').textContent = `${json.dir}/project.json`.replace(/\\/g, '/');
  if (!trackById(selectedTrack)) {
    selectedTrack = project.tracks.length ? project.tracks[project.tracks.length - 1].id : null;
    selectedNote = null;
  }
  render();
}

const isDirty = () => saveTimer != null || saving != null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) await saving;
  saving = (async () => {
    try {
      const res = await fetch('/api/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, baseMtime, dir: songDir }),
      });
      if (res.status === 409) {
        status('project.json が外部（Claude）で更新されたため、そちらを読み込みました。', 'warn');
        undoStack.length = 0;
        await loadProject();
      } else if (res.ok) {
        baseMtime = (await res.json()).mtime;
      } else {
        status(`保存に失敗しました: ${res.status}`, 'error');
      }
    } catch (e) {
      status(`保存に失敗しました（サーバーが止まっていませんか）: ${e.message}`, 'error');
    }
  })();
  await saving;
  saving = null;
}

// Apply a change made in the page: remember for undo, redraw, save.
function change(fn) {
  undoStack.push(JSON.stringify(project));
  if (undoStack.length > 100) undoStack.shift();
  fn();
  project = normalizeProject(project);
  scheduleSave();
  render();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return status('これ以上戻せません。');
  project = normalizeProject(JSON.parse(prev));
  if (!trackById(selectedTrack)) selectedTrack = null;
  selectedNote = null;
  scheduleSave();
  render();
  status('元に戻しました。');
}

async function poll() {
  try {
    const res = await fetch('/api/poll');
    const json = await res.json();
    if ((json.mtime !== baseMtime || json.dir !== songDir) && !isDirty() && mode !== 'recording' && mode !== 'busy') {
      undoStack.length = 0;
      await loadProject();
      status('Claude 側の変更を読み込みました。', 'ok');
    }
    for (const cmd of json.commands || []) {
      if (cmd.type === 'export') exportAudio(cmd.format, cmd.id);
    }
  } catch {
    /* server gone; the next save reports it */
  }
}

// ------------------------------------------------------------------ songs

// Each song is a folder next to the open one. Switching reloads the page,
// so nothing of the previous song (takes, undo history) can leak into the next.
async function loadSongs() {
  const sel = $('song');
  if (document.activeElement === sel) return;
  try {
    const { current, songs } = await (await fetch('/api/songs')).json();
    sel.textContent = '';
    for (const s of songs) sel.append(el('option', { value: s.folder, textContent: s.name === s.folder ? s.name : `${s.name}（${s.folder}）` }));
    sel.value = current;
    sel.dataset.current = current;
  } catch {
    /* server gone; the next save reports it */
  }
}

// body: {action: 'open', folder} | {action: 'new' | 'copy' | 'rename', name}
async function songAction(body) {
  if (mode === 'playing') stop();
  if (mode !== 'idle' || exporting) throw new Error('録音や書き出しが終わってから操作してください。');
  if (isDirty()) await save();
  const res = await fetch('/api/songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `失敗しました: ${res.status}`);
  location.reload();
}

function askSongName(action, title, initial) {
  $('songDialogTitle').textContent = title;
  $('songDialogName').value = initial;
  $('songDialogError').textContent = '';
  $('songForm').dataset.action = action;
  $('songDialog').showModal();
  $('songDialogName').select();
}

// ------------------------------------------------------------------ audio

async function ensureAudio() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = buildMaster(ctx);
  }
  if (ctx.state !== 'running') await ctx.resume();
}

// A synthetic room: decaying noise that gets duller as it dies away, plus a few early echoes.
// Seeded, so every playback and every export gets the same room.
function makeImpulse(actx, seconds) {
  const rate = actx.sampleRate;
  const pre = Math.round(rate * 0.012);
  const len = pre + Math.ceil(rate * seconds);
  const buf = actx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    let seed = 1234567 + c * 7919;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const tt = (i - pre) / rate;
      const env = Math.pow(10, (-3 * tt) / seconds); // -60 dB at `seconds`
      const a = Math.min(0.95, 0.25 + (0.6 * tt) / seconds);
      lp = lp * a + rnd() * (1 - a);
      d[i] = lp * env * Math.min(1, tt / 0.004);
    }
    for (const [ms, g] of c === 0 ? [[19, 0.5], [31, 0.35], [47, 0.25]] : [[23, 0.5], [37, 0.35], [53, 0.25]]) {
      const i = pre + Math.round((rate * ms) / 1000);
      if (i < len) d[i] += g * 0.3;
    }
  }
  return buf;
}

const masterKey = () => `${project.reverb}/${project.reverbTime}`;

// Output chain: tracks -> gain -> (dry + reverb) -> gentle compressor -> speakers.
function buildMaster(actx) {
  const gain = actx.createGain();
  gain.gain.value = MASTER_GAIN;
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 6;
  gain.connect(comp);
  if (project.reverb > 0) {
    const conv = actx.createConvolver();
    conv.buffer = makeImpulse(actx, project.reverbTime);
    const wet = actx.createGain();
    wet.gain.value = project.reverb * REVERB_GAIN;
    gain.connect(conv).connect(wet).connect(comp);
  }
  comp.connect(actx.destination);
  gain.out = comp;
  gain.key = masterKey();
  return gain;
}

// Rebuild the live output chain when the reverb settings changed.
function refreshMaster() {
  if (master.key === masterKey()) return;
  master.out.disconnect();
  master = buildMaster(ctx);
}

const sampleMidi = (midi) => Math.min(108, Math.max(21, midi));

function loadSample(instrument, midi) {
  const key = `${project.soundfont}/${instrument}/${midi}`;
  if (samples.has(key)) return Promise.resolve();
  if (failedInstruments.has(instrument)) {
    samples.set(key, null);
    return Promise.resolve();
  }
  if (!sampleJobs.has(key)) {
    sampleJobs.set(
      key,
      (async () => {
        try {
          const res = await fetch(`/sf/${key}.mp3`);
          if (!res.ok) throw new Error(await res.text());
          samples.set(key, await decodeCtx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          failedInstruments.add(instrument);
          samples.set(key, null);
        }
        sampleJobs.delete(key);
      })()
    );
  }
  return sampleJobs.get(key);
}

async function loadTake(track) {
  if (takes.has(track.id) || !track.take) return;
  try {
    const res = await fetch(`/${track.take}`);
    if (!res.ok) throw new Error(String(res.status));
    takes.set(track.id, await decodeCtx.decodeAudioData(await res.arrayBuffer()));
  } catch {
    status(`「${track.name}」の録音データ（${track.take}）を読めませんでした。`, 'warn');
  }
}

// Fetch every sample the current project needs.
async function preload() {
  const jobs = [];
  for (const tr of project.tracks) {
    if (tr.mute) continue;
    if (tr.instrument === 'voice') {
      jobs.push(loadTake(tr));
      continue;
    }
    if (!isKnownInstrument(tr.instrument)) {
      failedInstruments.add(tr.instrument);
      continue;
    }
    const pitches = new Set(effectiveNotes(project, tr).map((n) => sampleMidi(n.p)));
    for (const p of pitches) jobs.push(loadSample(tr.instrument, p));
  }
  if (jobs.length) {
    const before = failedInstruments.size;
    await Promise.all(jobs);
    if (failedInstruments.size > before) {
      status(`音色を取得できなかった楽器は簡易シンセ音で鳴らします: ${[...failedInstruments].join(', ')}`, 'warn');
    }
  }
}

function playNote(actx, dest, instrument, midi, when, dur, vel) {
  const g = actx.createGain();
  g.connect(dest);
  const sm = sampleMidi(midi);
  const buf = samples.get(`${project.soundfont}/${instrument}/${sm}`);
  const release = 0.25;
  const hold = Math.max(dur, 0.03);
  let src;
  if (buf) {
    src = actx.createBufferSource();
    src.buffer = buf;
    if (sm !== midi) src.playbackRate.value = Math.pow(2, (midi - sm) / 12);
    g.gain.setValueAtTime(vel, when);
    g.gain.setValueAtTime(vel, when + hold);
  } else {
    src = actx.createOscillator();
    src.type = 'triangle';
    src.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel * 0.4, when + 0.015);
    g.gain.setValueAtTime(vel * 0.4, when + hold);
  }
  g.gain.linearRampToValueAtTime(0, when + hold + release);
  src.connect(g);
  src.start(when);
  src.stop(when + hold + release + 0.02);
  return src;
}

// Schedule the whole project on `actx` so that project time `from` sounds at `t0`.
function scheduleProject(actx, dest, t0, from) {
  const nodes = [];
  for (const tr of project.tracks) {
    if (tr.mute) continue;
    const g = actx.createGain();
    g.gain.value = tr.volume;
    if (tr.pan) {
      const panner = actx.createStereoPanner();
      panner.pan.value = tr.pan;
      g.connect(panner).connect(dest);
    } else g.connect(dest);
    if (tr.instrument === 'voice') {
      const buf = takes.get(tr.id);
      if (!buf) continue;
      const off = tr.offsetMs / 1000;
      const startIn = Math.max(0, from - off);
      if (startIn >= buf.duration) continue;
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(t0 + Math.max(0, off - from), startIn);
      nodes.push(src);
      continue;
    }
    for (const n of effectiveNotes(project, tr)) {
      if (n.t + n.d <= from) continue;
      const late = Math.max(0, from - n.t);
      nodes.push(playNote(actx, g, tr.instrument, n.p, t0 + Math.max(0, n.t - from), n.d - late, n.v));
    }
  }
  return nodes;
}

function click(when, accent) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0.35, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
  osc.connect(g).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.06);
  return osc;
}

// Clicks for beat indices firstBeat.. ; stops after lastBeat unless `keepGoing`.
function startMetronome(s, firstBeat, lastBeat, keepGoing) {
  let beat = firstBeat;
  const beatLen = beatSec();
  const bpb = project.beatsPerBar;
  const tick = () => {
    while (keepGoing || beat <= lastBeat) {
      const when = s.t0 + beat * beatLen - s.from;
      if (when > ctx.currentTime + 1.5) break;
      if (when >= ctx.currentTime - 0.01) s.nodes.push(click(Math.max(when, ctx.currentTime), ((beat % bpb) + bpb) % bpb === 0));
      beat++;
    }
  };
  tick();
  s.metroTimer = setInterval(tick, 200);
}

function stopSession() {
  if (!session) return;
  clearInterval(session.metroTimer);
  for (const n of session.nodes) {
    try {
      n.stop();
    } catch {
      /* already stopped */
    }
  }
  session = null;
}

async function play() {
  if (mode === 'recording' || mode === 'busy') return;
  stopSession();
  mode = 'busy';
  updateButtons();
  status('音色を読み込み中…');
  try {
    await ensureAudio();
    await preload();
  } catch (e) {
    mode = 'idle';
    updateButtons();
    return status(`再生できません: ${e.message}`, 'error');
  }
  const dur = duration();
  if (dur <= 0) {
    mode = 'idle';
    updateButtons();
    return status('再生できるノートがまだありません。');
  }
  refreshMaster();
  const from = cursor >= dur - 0.05 ? 0 : cursor;
  const t0 = ctx.currentTime + 0.12;
  session = { kind: 'play', t0, from, end: dur, nodes: scheduleProject(ctx, master, t0, from) };
  if (project.metronome) startMetronome(session, Math.ceil(from / beatSec() - 1e-6), 0, true);
  mode = 'playing';
  if (!$('status').classList.contains('warn')) status('再生中…');
  updateButtons();
}

function stop() {
  if (mode === 'recording') return stopRecording();
  if (mode !== 'playing') return;
  stopSession();
  mode = 'idle';
  status('');
  updateButtons();
}

// ------------------------------------------------------------------ recording

async function ensureMic() {
  if (mic) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザではマイクを使えません（http://localhost で開いてください）。');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (e) {
    throw new Error(`マイクを使えません。ブラウザのマイク許可を確認してください（${e.name}）。`);
  }
  await ctx.audioWorklet.addModule('/recorder-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1 });
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(node).connect(silent).connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  mic = { stream, source, node, analyser, levelBuf: new Float32Array(1024) };
}

// Seconds between "the page scheduled a sound" and "the singer's answer reaches the recorder".
function roundTripLatency() {
  const settings = mic ? mic.stream.getAudioTracks()[0].getSettings() : {};
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (settings.latency || 0) + project.latencyMs / 1000;
}

async function record() {
  if (mode === 'busy') return;
  stopSession();
  mode = 'busy';
  updateButtons();
  try {
    await ensureAudio();
    await ensureMic();
    status('準備中…');
    await preload();
  } catch (e) {
    mode = 'idle';
    updateButtons();
    return status(e.message, 'error');
  }
  refreshMaster();
  const beatLen = beatSec();
  const countBeats = project.countInBars * project.beatsPerBar;
  const from = cursor;
  const t0 = ctx.currentTime + 0.2 + countBeats * beatLen;
  session = {
    kind: 'record',
    t0,
    from,
    end: Infinity,
    nodes: scheduleProject(ctx, master, t0, from),
    chunks: [],
    instrument: project.next.instrument,
  };
  const s = session;
  mic.node.port.onmessage = (e) => {
    if (e.data.done) s.onDone && s.onDone();
    else s.chunks.push(e.data);
  };
  mic.node.port.postMessage('start');
  const firstBeat = Math.round(from / beatLen);
  startMetronome(s, firstBeat - countBeats, firstBeat - 1, project.metronome);
  mode = 'recording';
  status(countBeats ? `カウントイン ${project.countInBars} 小節のあと録音が始まります。歌い終わったら「■ 停止して変換」。` : '録音中… 歌い終わったら「■ 停止して変換」。');
  updateButtons();
}

// Lay recorder chunks out by their audio-clock time. tb = clock time of sample 0.
function joinChunks(chunks, sr) {
  const tb = chunks[0].time;
  const last = chunks[chunks.length - 1];
  const all = new Float32Array(Math.round((last.time - tb) * sr) + last.samples.length + 1);
  for (const c of chunks) all.set(c.samples, Math.min(Math.round((c.time - tb) * sr), all.length - c.samples.length));
  return { all, tb };
}

async function stopRecording() {
  const s = session;
  if (!s || s.kind !== 'record') return;
  mode = 'busy';
  updateButtons();
  await new Promise((resolve) => {
    s.onDone = resolve;
    mic.node.port.postMessage('stop');
    setTimeout(resolve, 1000);
  });
  const latency = roundTripLatency();
  stopSession();

  const sr = ctx.sampleRate;
  let result = null;
  if (s.chunks.length) {
    const { all, tb } = joinChunks(s.chunks, sr);
    // Sample index that corresponds to project time `from`.
    const i0 = Math.round((s.t0 + latency - tb) * sr);
    if (i0 < all.length - sr * 0.1) {
      if (i0 >= 0) result = all.subarray(i0);
      else {
        result = new Float32Array(all.length - i0);
        result.set(all, -i0);
      }
    }
  }
  if (!result) {
    mode = 'idle';
    updateButtons();
    return status('録音が短すぎました（カウントイン中に止めた場合は録音されません）。', 'warn');
  }
  try {
    await addTake(result, sr, s.from, s.instrument);
  } catch (e) {
    status(`変換に失敗しました: ${e.message}`, 'error');
  }
  mode = 'idle';
  updateButtons();
}

function encodeWav(channels, sampleRate) {
  const n = channels[0].length;
  const nch = channels.length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * nch * 2, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true);
  dv.setUint16(32, nch * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Turn recorded samples (starting at project time `startPos`) into a new track.
async function addTake(samplesIn, sampleRate, startPos = 0, instrument = project.next.instrument) {
  status('ノートに変換中…');
  await sleep(30);
  const contextNotes = project.tracks.flatMap((tr) => tr.notes.map((n) => ({ p: n.p + tr.transpose, d: n.d })));
  const { notes, detuneCents } = analyzeTake(samplesIn, sampleRate, { snapToScale: project.snapToScale, contextNotes });
  // Draft: keep the voice for now and remember which instrument it should become.
  const draft = project.draft && instrument !== 'voice';
  if (!notes.length && instrument !== 'voice' && !draft) {
    status('音程を検出できませんでした。マイクに近づいて「ラ」「ナ」などではっきり歌ってみてください。', 'warn');
    return null;
  }
  const id = `t${Date.now().toString(36)}`;
  const pad = Math.round(startPos * sampleRate);
  const padded = new Float32Array(pad + samplesIn.length);
  padded.set(samplesIn, pad);
  const buffer = new AudioBuffer({ length: padded.length, sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(padded, 0);
  takes.set(id, buffer);

  let take = null;
  try {
    const res = await fetch(`/takes/${id}.wav`, { method: 'PUT', body: encodeWav([padded], sampleRate) });
    if (res.ok) take = (await res.json()).file;
  } catch {
    /* keep the notes even if the raw take could not be stored */
  }

  const round3 = (x) => Math.round(x * 1000) / 1000;
  change(() => {
    project.tracks.push({
      id,
      name: `${instrumentLabel(instrument).replace(/（.*/, '')} ${project.tracks.length + 1}`,
      instrument: draft ? 'voice' : instrument,
      planned: draft ? instrument : null,
      click: project.metronome,
      volume: 0.8,
      mute: false,
      transpose: 0,
      quantize: 0,
      offsetMs: 0,
      take,
      original: null,
      notes: notes.map((n) => ({ ...n, t: round3(n.t + startPos) })),
    });
    selectedTrack = id;
    selectedNote = null;
  });
  const tuning = Math.abs(detuneCents) >= 15 ? `（全体に ${detuneCents > 0 ? '+' : ''}${detuneCents} セント寄っていたので補正しました）` : '';
  if (draft) status('下書きとして録音しました（生声で再生されます）。続けて重ね録りし、録り終えたら Claude に「まとめて変換して」と頼んでください。', 'ok');
  else status(`${notes.length} 個のノートに変換しました${tuning}。再生して確認し、続けて重ね録りできます。`, 'ok');
  if (!project.latencyCalibrated && project.tracks.filter((t) => t.take).length === 2) calibrate(false);
  return id;
}

// The delay belongs to the headphones, microphone and browser, not to one song,
// so remember it in this browser and reuse it for new songs.
const LATENCY_KEY = 'humming.latencyMs';
function rememberLatency(ms) {
  try {
    localStorage.setItem(LATENCY_KEY, String(ms));
  } catch {
    /* private window etc.: the value still lives in the project */
  }
}
function recallLatency() {
  try {
    const v = localStorage.getItem(LATENCY_KEY);
    return v == null || !isFinite(Number(v)) ? null : Number(v);
  } catch {
    return null;
  }
}

// Stand-alone delay measurement: play clicks, the user voices "ah" on them, and the
// distance between clicks and voice (measured exactly like a real take) becomes the correction.
const CAL = { beat: 0.6, listen: 4, total: 12 };
async function calibrateWithClicks() {
  if (mode !== 'idle') return;
  mode = 'busy';
  updateButtons();
  try {
    await ensureAudio();
    await ensureMic();
  } catch (e) {
    mode = 'idle';
    updateButtons();
    return status(e.message, 'error');
  }
  const chunks = [];
  let finish;
  const finished = new Promise((r) => (finish = r));
  mic.node.port.onmessage = (e) => (e.data.done ? finish() : chunks.push(e.data));
  mic.node.port.postMessage('start');
  const t0 = ctx.currentTime + 0.5;
  for (let k = 0; k < CAL.total; k++) click(t0 + k * CAL.beat, k < CAL.listen);
  status(`遅延を計測します。最初の ${CAL.listen} 回（高い音）は聞くだけ…`);
  await sleep((0.5 + (CAL.listen - 0.5) * CAL.beat) * 1000);
  status(`今です。クリックに合わせて短く「あ」と ${CAL.total - CAL.listen} 回、声を出してください。`, 'warn');
  await sleep(((CAL.total - CAL.listen + 0.5) * CAL.beat + 0.5) * 1000);
  mic.node.port.postMessage('stop');
  await Promise.race([finished, sleep(1000)]);
  mode = 'idle';
  updateButtons();
  if (!chunks.length) return status('マイクから音が届きませんでした。マイクの設定を確認してください。', 'error');

  const sr = ctx.sampleRate;
  const { all, tb } = joinChunks(chunks, sr);
  // Where each click would sit in this recording if the current correction were exact.
  const base = t0 + roundTripLatency() - tb;
  const clicks = Array.from({ length: CAL.total }, (_, k) => base + k * CAL.beat);
  const r = measureClickLag(all, sr, clicks);
  if (!r) {
    return status('うまく測れませんでした。クリックに合わせて、短くはっきり「あ」と 4 回以上声を出してください（手拍子でも測れます）。', 'warn');
  }
  const ms = Math.round(r.lag * 1000);
  const detail = `一致 ${r.matched} 回、ばらつき ±${Math.round(r.spread * 1000)} ms`;
  const stale = project.tracks.filter((t) => t.take && !t.original).map((t) => t.id);
  change(() => {
    project.latencyCalibrated = true;
    if (Math.abs(ms) < 8) return;
    project.latencyMs += ms;
    // Takes recorded with the old setting are off by the same amount.
    for (const id of stale) trackById(id).offsetMs -= ms;
  });
  rememberLatency(project.latencyMs);
  if (Math.abs(ms) < 8) return status(`遅延を計測しました: ずれは ${ms} ms でほぼありません（${detail}）。このまま録音できます。`, 'ok');
  const moved = stale.length ? ` 録音済みの ${stale.length} トラックも同じだけずらしました。` : '';
  status(`遅延を計測しました: 録音が ${Math.abs(ms)} ms ${ms > 0 ? '遅れて' : '早く'}入っていたので補正しました（遅延補正 ${project.latencyMs} ms、${detail}）。${moved}このブラウザでは次の曲にも引き継ぎます。`, 'ok');
}

// Compare the first two recordings and correct the overdub delay.
// manual = the user pressed the button (always report); otherwise stay quiet unless something changed.
function calibrate(manual) {
  const pair = project.tracks.filter((t) => t.take).slice(0, 2);
  if (pair.length < 2) {
    if (manual) status('遅延の計測には録音が 2 つ必要です。2 つ目を重ね録りすると自動で計測します。', 'warn');
    return;
  }
  const side = (t) => ({
    // Cleaned-up notes sit on the grid, so measure from the notes as they were sung.
    onsets: (t.original || t.notes).map((n) => n.t + t.offsetMs / 1000),
    click: t.click == null ? project.metronome : t.click,
  });
  const r = measureLatency(project.bpm, side(pair[0]), side(pair[1]));
  const prev = $('status').textContent;
  if (!r) {
    if (!manual) return;
    return status('遅延を計測できませんでした（音数が少ないか、2 つの録音のリズムが対応していません）。', 'warn');
  }
  const ms = Math.round(r.lag * 1000);
  const detail = `${r.method === 'grid' ? 'メトロノーム基準' : '1 つ目の録音基準'}、一致 ${r.matched} 音、ばらつき ±${Math.round(r.spread * 1000)} ms`;
  if (Math.abs(ms) < 10) {
    change(() => (project.latencyCalibrated = true));
    return status(`${manual ? '' : prev + ' '}遅延を計測しました: ずれは ${ms} ms でほぼありません（${detail}）。`, 'ok');
  }
  const targets = (r.method === 'grid' ? pair : [pair[1]]).filter((t) => !t.original).map((t) => t.id);
  change(() => {
    project.latencyMs += ms;
    for (const id of targets) trackById(id).offsetMs -= ms;
    project.latencyCalibrated = true;
  });
  rememberLatency(project.latencyMs);
  status(
    `${manual ? '' : prev + ' '}遅延を計測しました: 録音が ${Math.abs(ms)} ms ${ms > 0 ? '遅れて' : '早く'}入っていたので補正しました（${detail}）。今後の録音にも適用されます。違和感があれば Ctrl+Z で戻せます。`,
    'ok'
  );
}

// ------------------------------------------------------------------ export

async function renderMix() {
  await preload();
  const dur = duration();
  if (dur <= 0) throw new Error('書き出せるノートがありません');
  const octx = new OfflineAudioContext(2, Math.ceil((dur + 1 + (project.reverb > 0 ? project.reverbTime : 0.5)) * EXPORT_RATE), EXPORT_RATE);
  scheduleProject(octx, buildMaster(octx), 0, 0);
  const mix = await octx.startRendering();
  // Bring the loudest point to about -1 dBFS so exports are not quiet.
  let peak = 0;
  for (let c = 0; c < mix.numberOfChannels; c++) for (const v of mix.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  window.humming.mixPeak = peak; // what live playback would reach before any normalizing
  if (peak > 0.001) {
    const k = 0.89 / peak;
    for (let c = 0; c < mix.numberOfChannels; c++) {
      const d = mix.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return mix;
}

async function encodeMp3(buffer) {
  const enc = new lamejs.Mp3Encoder(2, buffer.sampleRate, 192);
  const toInt16 = (f) => {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const left = toInt16(buffer.getChannelData(0));
  const right = toInt16(buffer.getChannelData(1));
  const parts = [];
  const block = 1152 * 40;
  for (let i = 0; i < left.length; i += block) {
    const out = enc.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (out.length) parts.push(new Uint8Array(out));
    await sleep(0);
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

let exporting = false;
// format: 'mp3' | 'wav'. cmdId is set when Claude's CLI asked for the export.
async function exportAudio(format, cmdId = null) {
  if (exporting) {
    if (cmdId) reportCommandError(cmdId, '別の書き出しが実行中です');
    return null;
  }
  exporting = true;
  updateButtons();
  try {
    status(`${format.toUpperCase()} を書き出し中…`);
    const mix = await renderMix();
    const blob = format === 'wav' ? encodeWav([mix.getChannelData(0), mix.getChannelData(1)], mix.sampleRate) : await encodeMp3(mix);
    const q = new URLSearchParams({ format, name: project.name });
    if (cmdId) q.set('cmd', cmdId);
    const res = await fetch(`/api/export?${q}`, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`保存に失敗: ${res.status}`);
    const { file } = await res.json();
    if (!cmdId) download(blob, file.split(/[\\/]/).pop());
    status(`書き出しました: ${file}`, 'ok');
    return file;
  } catch (e) {
    status(`書き出しに失敗しました: ${e.message}`, 'error');
    if (cmdId) reportCommandError(cmdId, e.message);
    return null;
  } finally {
    exporting = false;
    updateButtons();
  }
}

function reportCommandError(id, error) {
  fetch(`/api/command/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error }) }).catch(() => {});
}

async function exportMidi() {
  try {
    if (isDirty()) await save();
    const res = await fetch('/api/export/midi');
    if (!res.ok) throw new Error(String(res.status));
    const file = decodeURIComponent(res.headers.get('X-Saved-To') || 'humming.mid');
    download(await res.blob(), file.split(/[\\/]/).pop());
    status(`書き出しました: ${file}`, 'ok');
  } catch (e) {
    status(`MIDI の書き出しに失敗しました: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ UI

function updateButtons() {
  const rec = $('rec');
  rec.textContent = mode === 'recording' ? '■ 停止して変換' : '● 録音';
  rec.classList.toggle('on', mode === 'recording');
  rec.disabled = mode === 'busy';
  $('play').disabled = mode === 'recording' || mode === 'busy';
  $('stop').disabled = mode === 'idle' || mode === 'busy';
  $('calibrate').disabled = mode !== 'idle';
  for (const id of ['exportMp3', 'exportWav', 'exportMidi', 'song', 'songNew', 'songCopy', 'songRename']) {
    $(id).disabled = exporting || mode === 'recording' || mode === 'busy';
  }
}

function fillInstrumentSelect(sel, value) {
  sel.textContent = '';
  const choices = INSTRUMENT_CHOICES.some(([n]) => n === value) ? INSTRUMENT_CHOICES : [...INSTRUMENT_CHOICES, [value, value]];
  for (const [name, label] of choices) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

function render() {
  const active = document.activeElement;
  if (!$('soundfont').options.length) for (const [n, label] of SOUNDFONTS) $('soundfont').append(el('option', { value: n, textContent: label }));
  $('soundfont').value = project.soundfont;
  for (const id of ['bpm', 'beatsPerBar', 'countInBars', 'latencyMs', 'reverb']) {
    if (active !== $(id)) $(id).value = project[id];
  }
  $('metronome').checked = project.metronome;
  $('snapToScale').checked = project.snapToScale;
  $('draft').checked = project.draft;
  fillInstrumentSelect($('nextInstrument'), project.next.instrument);
  $('empty').hidden = project.tracks.length > 0;
  $('tracks').hidden = project.tracks.length === 0;

  const body = $('tracks').tBodies[0];
  body.textContent = '';
  for (const tr of project.tracks) {
    const id = tr.id;
    const set = (key, value) => change(() => (trackById(id)[key] = value));
    const name = el('input', { type: 'text', value: tr.name, onchange: (e) => set('name', e.target.value) });
    const inst = el('select', { onchange: (e) => set('instrument', e.target.value) });
    fillInstrumentSelect(inst, tr.instrument);
    if (!tr.take) [...inst.options].forEach((o) => (o.disabled = o.value === 'voice'));
    // A draft (voice) track also shows the instrument it is meant to become.
    const planned = el('select', { title: 'まとめて変換するときの楽器', onchange: (e) => set('planned', e.target.value || null) });
    planned.append(el('option', { value: '', textContent: '変換後: 未定' }));
    for (const [n, label] of INSTRUMENT_CHOICES) if (n !== 'voice') planned.append(el('option', { value: n, textContent: `変換後: ${label}` }));
    if (tr.planned && ![...planned.options].some((o) => o.value === tr.planned)) planned.append(el('option', { value: tr.planned, textContent: `変換後: ${tr.planned}` }));
    planned.value = tr.planned || '';
    planned.hidden = tr.instrument !== 'voice';
    const vol = el('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value: tr.volume, onchange: (e) => set('volume', Number(e.target.value)) });
    const pan = el('input', { type: 'range', min: -1, max: 1, step: 0.05, value: tr.pan, title: '左右の位置（中央が 0）', onchange: (e) => set('pan', Number(e.target.value)) });
    const mute = el('input', { type: 'checkbox', checked: tr.mute, onchange: (e) => set('mute', e.target.checked) });
    const transpose = el('input', { type: 'number', step: 1, min: -48, max: 48, value: tr.transpose, onchange: (e) => set('transpose', Number(e.target.value)) });
    const octDown = el('button', { textContent: '−8va', title: '1 オクターブ下げる', onclick: () => set('transpose', tr.transpose - 12) });
    const octUp = el('button', { textContent: '+8va', title: '1 オクターブ上げる', onclick: () => set('transpose', tr.transpose + 12) });
    const quant = el('select', { onchange: (e) => set('quantize', Number(e.target.value)) });
    for (const [v, label] of [[0, 'なし'], [1, '4 分'], [2, '8 分'], [3, '3 連'], [4, '16 分']]) quant.append(el('option', { value: v, textContent: label }));
    quant.value = tr.quantize;
    const offset = el('input', { type: 'number', step: 10, value: tr.offsetMs, title: 'マイナスで前へ、プラスで後ろへ', onchange: (e) => set('offsetMs', Number(e.target.value)) });
    const del = el('button', {
      textContent: '削除',
      onclick: () =>
        change(() => {
          project.tracks = project.tracks.filter((t) => t.id !== id);
          if (selectedTrack === id) selectedTrack = null;
          selectedNote = null;
        }),
    });
    // After Claude's clean-up the pre-clean-up notes are kept; let the user flip between them.
    const swap = el('button', {
      textContent: '清書前と入れ替え',
      title: 'Claude が清書する前のノートと入れ替えます（もう一度押すと戻ります）',
      hidden: !tr.original,
      onclick: () =>
        change(() => {
          const t = trackById(id);
          [t.notes, t.original] = [t.original, t.notes];
          selectedNote = null;
        }),
    });
    const row = el(
      'tr',
      { className: id === selectedTrack ? 'sel' : '' },
      el('td', {}, el('span', { className: 'chip', style: `background:${colorOf(tr)}` })),
      el('td', {}, name),
      el('td', {}, inst, ' ', planned),
      el('td', {}, vol),
      el('td', {}, pan),
      el('td', {}, mute),
      el('td', {}, transpose, ' ', octDown, ' ', octUp),
      el('td', {}, quant),
      el('td', {}, offset),
      el('td', {}, String(tr.notes.length)),
      el('td', {}, swap),
      el('td', {}, del)
    );
    row.addEventListener('mousedown', () => {
      if (selectedTrack !== id) {
        selectedTrack = id;
        selectedNote = null;
        for (const r of body.rows) r.classList.toggle('sel', r === row);
      }
    });
    body.appendChild(row);
  }
  updateButtons();
}

function pitchRange() {
  let lo = 127;
  let hi = 0;
  for (const tr of project.tracks) {
    for (const n of effectiveNotes(project, tr)) {
      lo = Math.min(lo, n.p);
      hi = Math.max(hi, n.p);
    }
  }
  if (lo > hi) return [55, 79];
  lo -= 3;
  hi += 3;
  while (hi - lo < 16) {
    lo--;
    hi++;
  }
  return [Math.max(0, lo), Math.min(127, hi)];
}

function playhead() {
  if (!session || !ctx) return null;
  return session.from + (ctx.currentTime - session.t0);
}

function draw() {
  const canvas = $('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!project) return;

  const [lo, hi] = pitchRange();
  const rows = hi - lo + 1;
  const top = 16;
  const rowH = (h - top) / rows;
  const x = (t) => (t - view.start) * view.pxPerSec;
  const y = (p) => top + (hi - p) * rowH;

  for (let p = lo; p <= hi; p++) {
    const black = [1, 3, 6, 8, 10].includes(p % 12);
    g.fillStyle = black ? '#14171c' : '#191c22';
    g.fillRect(0, y(p), w, rowH);
    if (p % 12 === 0) {
      g.fillStyle = '#2b303b';
      g.fillRect(0, y(p) + rowH - 1, w, 1);
    }
  }

  const beatLen = beatSec();
  const firstBeat = Math.max(0, Math.floor(view.start / beatLen));
  g.font = '11px system-ui, sans-serif';
  for (let b = firstBeat; x(b * beatLen) < w; b++) {
    const bar = b % project.beatsPerBar === 0;
    g.fillStyle = bar ? '#3a4050' : '#232731';
    g.fillRect(Math.round(x(b * beatLen)), bar ? 0 : top, 1, h);
    if (bar) {
      g.fillStyle = '#9aa1b2';
      g.fillText(String(b / project.beatsPerBar + 1), x(b * beatLen) + 4, 12);
    }
  }

  const order = project.tracks.filter((t) => t.id !== selectedTrack).concat(project.tracks.filter((t) => t.id === selectedTrack));
  for (const tr of order) {
    g.globalAlpha = tr.mute ? 0.25 : tr.id === selectedTrack || !selectedTrack ? 1 : 0.6;
    g.fillStyle = colorOf(tr);
    for (const n of effectiveNotes(project, tr)) {
      const nx = x(n.t);
      const nw = Math.max(2, n.d * view.pxPerSec - 1);
      if (nx + nw < 0 || nx > w) continue;
      g.fillRect(nx, y(n.p) + 1, nw, Math.max(2, rowH - 2));
      if (tr.id === selectedTrack && n.src === selectedNote) {
        g.globalAlpha = 1;
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.strokeRect(nx, y(n.p) + 1, nw, Math.max(2, rowH - 2));
        g.globalAlpha = tr.mute ? 0.25 : 1;
      }
    }
  }
  g.globalAlpha = 1;

  g.fillStyle = '#6b7385';
  for (let p = lo; p <= hi; p++) {
    if (p % 12 === 0) g.fillText(`C${p / 12 - 1}`, 3, y(p) + rowH - 2);
  }

  g.fillStyle = '#ffd24d';
  g.fillRect(Math.round(x(cursor)), 0, 1, h);
  const ph = playhead();
  if (ph != null) {
    g.fillStyle = mode === 'recording' ? '#ff5a5a' : '#ffffff';
    g.fillRect(Math.round(x(ph)), 0, 2, h);
  }
  return { lo, hi, top, rowH };
}

function frame() {
  requestAnimationFrame(frame);
  let ph = playhead();
  if (ph != null && mode === 'playing' && ph > session.end + 0.4) {
    stop();
    ph = null;
  }
  if (ph != null) {
    const w = $('canvas').clientWidth;
    const px = (ph - view.start) * view.pxPerSec;
    if (px > w * 0.9 || px < 0) view.start = Math.max(0, ph - (w * 0.1) / view.pxPerSec);
  }
  const shown = ph != null ? Math.max(0, ph) : cursor;
  const counting = ph != null && ph < session.from && mode === 'recording';
  $('clock').textContent = counting ? `-${(session.from - ph).toFixed(1)}` : `${Math.floor(shown / 60)}:${(shown % 60).toFixed(1).padStart(4, '0')}`;
  if (mic) {
    mic.analyser.getFloatTimeDomainData(mic.levelBuf);
    let e = 0;
    for (const v of mic.levelBuf) e += v * v;
    const db = 20 * Math.log10(Math.sqrt(e / mic.levelBuf.length) + 1e-6);
    $('level').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  }
  draw();
}

function onCanvasClick(e) {
  const geo = draw();
  if (!geo) return;
  const rect = $('canvas').getBoundingClientRect();
  const t = (e.clientX - rect.left) / view.pxPerSec + view.start;
  const p = geo.hi - Math.floor((e.clientY - rect.top - geo.top) / geo.rowH);
  const order = project.tracks.filter((tr) => tr.id === selectedTrack).concat(project.tracks.filter((tr) => tr.id !== selectedTrack));
  for (const tr of order) {
    const hit = effectiveNotes(project, tr).find((n) => n.p === p && t >= n.t && t <= n.t + Math.max(n.d, 3 / view.pxPerSec));
    if (hit) {
      selectedTrack = tr.id;
      selectedNote = hit.src;
      return render();
    }
  }
  selectedNote = null;
  if (mode === 'idle') {
    const beatLen = beatSec();
    cursor = Math.max(0, Math.round(t / beatLen) * beatLen);
  }
}

function onKey(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
  }
  if (e.code === 'Space') {
    e.preventDefault();
    return mode === 'idle' ? play() : stop();
  }
  const tr = trackById(selectedTrack);
  if (!tr || selectedNote == null || !tr.notes[selectedNote] || mode === 'recording' || mode === 'busy') return;
  const edit = (fn) => {
    e.preventDefault();
    change(() => fn(trackById(selectedTrack).notes[selectedNote]));
  };
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const idx = selectedNote;
    change(() => trackById(selectedTrack).notes.splice(idx, 1));
    selectedNote = null;
  } else if (e.key === 'ArrowUp') edit((n) => (n.p = Math.min(127, n.p + (e.shiftKey ? 12 : 1))));
  else if (e.key === 'ArrowDown') edit((n) => (n.p = Math.max(0, n.p - (e.shiftKey ? 12 : 1))));
  else if (e.key === 'ArrowLeft') edit((n) => (n.t = Math.max(0, Math.round((n.t - 0.02) * 1000) / 1000)));
  else if (e.key === 'ArrowRight') edit((n) => (n.t = Math.round((n.t + 0.02) * 1000) / 1000));
}

function bind() {
  const num = (id, key) => $(id).addEventListener('change', (e) => change(() => (project[key] = Number(e.target.value))));
  // Pick up songs Claude created meanwhile, before the list opens.
  $('song').addEventListener('pointerenter', loadSongs);
  $('song').addEventListener('change', (e) =>
    songAction({ action: 'open', folder: e.target.value }).catch((err) => {
      e.target.value = e.target.dataset.current;
      status(err.message, 'error');
    })
  );
  $('songNew').addEventListener('click', () => askSongName('new', '新しい曲の名前', ''));
  $('songCopy').addEventListener('click', () => askSongName('copy', '複製した曲の名前', `${project.name} のコピー`));
  $('songRename').addEventListener('click', () => askSongName('rename', '曲の新しい名前', project.name));
  $('songDialogCancel').addEventListener('click', () => $('songDialog').close());
  $('songForm').addEventListener('submit', (e) => {
    e.preventDefault();
    songAction({ action: e.target.dataset.action, name: $('songDialogName').value }).catch((err) => ($('songDialogError').textContent = err.message));
  });
  num('bpm', 'bpm');
  num('beatsPerBar', 'beatsPerBar');
  num('countInBars', 'countInBars');
  num('latencyMs', 'latencyMs');
  num('reverb', 'reverb');
  $('soundfont').addEventListener('change', (e) =>
    change(() => {
      project.soundfont = e.target.value;
      failedInstruments.clear();
    })
  );
  $('metronome').addEventListener('change', (e) => change(() => (project.metronome = e.target.checked)));
  $('snapToScale').addEventListener('change', (e) => change(() => (project.snapToScale = e.target.checked)));
  $('draft').addEventListener('change', (e) => change(() => (project.draft = e.target.checked)));
  $('calibrate').addEventListener('click', calibrateWithClicks);
  $('latencyMs').addEventListener('change', (e) => rememberLatency(Number(e.target.value) || 0));
  $('nextInstrument').addEventListener('change', (e) => change(() => (project.next.instrument = e.target.value)));
  $('rec').addEventListener('click', () => (mode === 'recording' ? stopRecording() : record()));
  $('play').addEventListener('click', play);
  $('stop').addEventListener('click', stop);
  $('undo').addEventListener('click', undo);
  $('exportMp3').addEventListener('click', () => exportAudio('mp3'));
  $('exportWav').addEventListener('click', () => exportAudio('wav'));
  $('exportMidi').addEventListener('click', exportMidi);
  $('canvas').addEventListener('click', onCanvasClick);
  $('canvas').addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      view.start = Math.max(0, view.start + delta / view.pxPerSec);
    },
    { passive: false }
  );
  document.addEventListener('keydown', onKey);
}

// Exposed for debugging and automated checks.
window.humming = {
  get project() {
    return project;
  },
  get mode() {
    return mode;
  },
  addTake,
  renderMix,
  exportAudio,
  analyzeTake,
  save,
};

bind();
await loadProject();
// A fresh song starts with the delay measured earlier in this browser.
{
  const saved = recallLatency();
  if (saved != null && !project.latencyCalibrated && !project.tracks.length && project.latencyMs === 0) {
    project.latencyMs = saved;
    project.latencyCalibrated = true;
    scheduleSave();
    render();
  }
}
setInterval(poll, 1500);
requestAnimationFrame(frame);
status('「● 録音」を押して鼻歌をどうぞ。');
