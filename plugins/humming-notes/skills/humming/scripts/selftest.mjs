// Self-test: synthesize a hummed melody, run the analyzer, check the notes and the MIDI writer.
// Run: node selftest.mjs
import { analyzeTake, measureLatency, measureClickLag } from './analyze.mjs';
import { buildMidi, normalizeProject, effectiveNotes } from './shared.mjs';

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

process.exit(failed ? 1 : 0);
