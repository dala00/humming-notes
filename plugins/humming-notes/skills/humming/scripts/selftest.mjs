// Self-test: synthesize a hummed melody, run the analyzer, check the notes and the MIDI writer.
// Run: node selftest.mjs
import { analyzeTake } from './analyze.mjs';
import { buildMidi, normalizeProject, effectiveNotes } from './shared.mjs';

const SR = 48000;
function hum(melody, { detune = 0, vibrato = 0.2, noise = 0.01 } = {}) {
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
      out[base + i] += 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * (Math.random() * 2 - 1);
  return out;
}

let failed = 0;
function check(name, melody, opts) {
  const { notes, detuneCents } = analyzeTake(hum(melody, opts), SR);
  const ok =
    notes.length === melody.length &&
    notes.every((n, i) => n.p === melody[i].p && Math.abs(n.t - melody[i].t) < 0.06 && Math.abs(n.d - melody[i].d) < 0.1);
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

const silent = analyzeTake(new Float32Array(SR * 2).map(() => 0.002 * (Math.random() * 2 - 1)), SR);
console.log(`${silent.notes.length === 0 ? 'ok  ' : 'FAIL'} silence gives no notes`);
if (silent.notes.length) failed++;

const project = normalizeProject({ bpm: 120, tracks: [{ instrument: 'flute', quantize: 2, notes: [{ t: 0.03, d: 0.22, p: 60 }, { t: 0.27, d: 0.5, p: 62 }] }] });
const eff = effectiveNotes(project, project.tracks[0]);
const midi = buildMidi(project);
const midiOk = eff[0].t === 0 && eff[0].d === 0.25 && eff[1].t === 0.25 && String.fromCharCode(...midi.slice(0, 4)) === 'MThd' && midi[11] === 2;
console.log(`${midiOk ? 'ok  ' : 'FAIL'} quantize + MIDI header`);
if (!midiOk) failed++;

process.exit(failed ? 1 : 0);
