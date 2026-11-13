// Humming -> notes. Pure functions, shared by the browser page, the CLI and the self-test.
//
// trackPitch(samples, sampleRate)  -> frame-level pitch curve (what the singer actually did)
// analyzeTake(samples, sampleRate) -> { notes: [{t, d, p, v}], detuneCents, key }
//   t = start in seconds, d = duration in seconds, p = MIDI pitch, v = velocity 0..1

const F_MIN = 65; // C2
const F_MAX = 1100; // ~C6
const YIN_THRESHOLD = 0.15;
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function downsample(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 16000));
  if (factor === 1) return { data: samples, rate: sampleRate };
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) s += samples[base + k];
    out[i] = s / factor;
  }
  return { data: out, rate: sampleRate / factor };
}

// YIN pitch detector for one frame. Returns frequency in Hz, or 0 when unvoiced.
function yin(x, start, len, tauMin, tauMax, rate, scratch) {
  const d = scratch;
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < len; j++) {
      const diff = x[start + j] - x[start + j + tau];
      sum += diff * diff;
    }
    running += sum;
    d[tau] = running > 0 ? (sum * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < YIN_THRESHOLD) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) better = tau + (a - c) / (2 * denom);
  }
  return rate / better;
}

function median(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Frame-level analysis, one frame every 10 ms.
//   pitch[i]: MIDI note as a float (0 = no pitch), rms[i]: loudness,
//   detune: how far the singer sits from the A=440 semitone grid, in semitones.
export function trackPitch(samples, sampleRate) {
  const { data, rate } = downsample(samples, sampleRate);
  const tauMin = Math.max(2, Math.floor(rate / F_MAX));
  const tauMax = Math.ceil(rate / F_MIN);
  const len = Math.max(tauMax, Math.round(rate * 0.03));
  const frame = len + tauMax + 1;
  const hop = Math.round(rate * 0.01);
  const hopSec = hop / rate;
  const count = data.length >= frame ? Math.floor((data.length - frame) / hop) + 1 : 0;
  const pitch = new Float32Array(count);
  const rms = new Float32Array(count);
  if (!count) return { hopSec, count, pitch, rms, detune: 0 };

  const raw = new Float32Array(count);
  const scratch = new Float32Array(tauMax + 2);
  for (let i = 0; i < count; i++) {
    const start = i * hop;
    let e = 0;
    for (let j = 0; j < len; j++) e += data[start + j] * data[start + j];
    rms[i] = Math.sqrt(e / len);
  }
  const loud = Array.from(rms).sort((a, b) => a - b)[Math.floor(count * 0.95)] || 0;
  const gate = Math.max(0.004, loud * 0.08);
  for (let i = 0; i < count; i++) {
    if (rms[i] < gate) continue;
    const f = yin(data, i * hop, len, tauMin, tauMax, rate, scratch);
    if (f >= F_MIN && f <= F_MAX) raw[i] = 69 + 12 * Math.log2(f / 440);
  }

  // Median filter kills single-frame octave jumps and glitches.
  for (let i = 0; i < count; i++) {
    if (!raw[i]) continue;
    const win = [];
    for (let k = -2; k <= 2; k++) {
      const v = raw[i + k];
      if (v) win.push(v);
    }
    pitch[i] = win.length >= 3 ? median(win) : raw[i];
  }

  // People rarely hum at A=440. Estimate the common offset from the semitone grid.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < count; i++) {
    if (!pitch[i]) continue;
    const a = 2 * Math.PI * (pitch[i] - Math.round(pitch[i]));
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const detune = sx || sy ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;
  return { hopSec, count, pitch, rms, detune, gate };
}

// Best-fitting major scale (its relative minor shares the same notes).
// weights: 12 numbers, how much each pitch class was sung. Returns null when unclear.
export function estimateKey(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    let inScale = 0;
    for (const step of MAJOR) inScale += weights[(tonic + step) % 12];
    // Tie-break toward keys whose tonic and fifth are actually used.
    const score = inScale + 0.1 * (weights[tonic] + weights[(tonic + 7) % 12]);
    if (!best || score > best.score) best = { tonic, score, fit: inScale / total };
  }
  return {
    tonic: best.tonic,
    fit: best.fit,
    name: `${PITCH_CLASS_NAMES[best.tonic]} メジャー / ${PITCH_CLASS_NAMES[(best.tonic + 9) % 12]} マイナー`,
    scale: MAJOR.map((s) => (best.tonic + s) % 12),
  };
}

// opts.snapToScale (default true): pull ambiguous out-of-key notes onto the key.
// opts.contextNotes: notes already in the song ([{p, d}]), used to judge the key.
export function analyzeTake(samples, sampleRate, opts = {}) {
  const minNote = opts.minNoteSec ?? 0.07;
  const { hopSec, count, pitch, rms, detune } = trackPitch(samples, sampleRate);
  if (!count) return { notes: [], detuneCents: 0, key: null };

  // Segment frames into raw notes: split on silence and on pitch moving away.
  const segs = [];
  let cur = null;
  let gap = 0;
  let away = 0;
  let level = 0;
  const close = () => {
    if (cur) segs.push(cur);
    cur = null;
    away = 0;
  };
  for (let i = 0; i < count; i++) {
    const m = pitch[i] ? pitch[i] - detune : 0;
    if (!m) {
      gap++;
      // A breathy dropout keeps its loudness; a consonant or a rest does not.
      const soft = cur && rms[i] > level * 0.3;
      if (cur && gap > (soft ? 8 : 2)) close();
      continue;
    }
    if (gap > 0) away = 0;
    gap = 0;
    if (!cur) {
      cur = { start: i, end: i + 1, vals: [m] };
      level = rms[i];
      continue;
    }
    level = level * 0.9 + rms[i] * 0.1;
    const center = median(cur.vals);
    if (Math.abs(m - center) > 0.7) {
      away++;
      if (away >= 3) {
        const first = i - away + 1;
        const moved = cur.vals.splice(cur.vals.length - (away - 1), away - 1);
        cur.end = first;
        segs.push(cur);
        cur = { start: first, end: i + 1, vals: moved.concat([m]) };
        away = 0;
      } else {
        cur.vals.push(m);
        cur.end = i + 1;
      }
    } else {
      away = 0;
      cur.vals.push(m);
      cur.end = i + 1;
    }
  }
  close();

  // Split a held pitch that was re-articulated ("na na na"): a clear dip in loudness.
  const split = [];
  const minFrames = Math.max(2, Math.round(minNote / hopSec));
  for (const s of segs) {
    // vals has one entry per voiced frame; map frame index -> vals index.
    const voicedIdx = [];
    for (let i = s.start; i < s.end; i++) if (pitch[i]) voicedIdx.push(i);
    const valsBetween = (a, b) => s.vals.filter((_, k) => voicedIdx[k] >= a && voicedIdx[k] < b);
    let from = s.start;
    let peak = 0;
    let dip = false;
    for (let i = s.start; i < s.end; i++) {
      peak = Math.max(peak, rms[i]);
      const isMin = i > from + minFrames && i < s.end - minFrames && rms[i] <= rms[i - 1] && rms[i] < rms[i + 1];
      if (!isMin || !pitch[i] || rms[i] > peak * 0.4) continue;
      let ahead = 0;
      for (let k = i + 1; k < Math.min(s.end, i + 12); k++) ahead = Math.max(ahead, rms[k]);
      if (rms[i] > ahead * 0.4) continue;
      split.push({ start: from, end: i, vals: valsBetween(from, i), dip });
      from = i;
      peak = 0;
      dip = true;
    }
    split.push({ start: from, end: s.end, vals: valsBetween(from, s.end), dip });
  }

  // Short blips: glue onto a touching neighbour (pitch scoops), otherwise drop.
  const kept = [];
  for (let i = 0; i < split.length; i++) {
    const s = split[i];
    if (!s.vals.length) continue;
    if (s.end - s.start >= minFrames) {
      kept.push(s);
      continue;
    }
    const prev = kept[kept.length - 1];
    const next = split[i + 1];
    if (next && next.start - s.end <= 2 && next.end - next.start >= minFrames) {
      next.start = s.start; // scoop into the next note
      next.dip = next.dip && s.dip;
    } else if (prev && s.start - prev.end <= 2) {
      prev.end = s.end; // tail of the previous note
    }
  }

  // Judge the key from what was sung (plus the rest of the song).
  const weights = new Array(12).fill(0);
  let sungSec = 0;
  for (const s of kept) {
    const pc = ((Math.round(median(s.vals)) % 12) + 12) % 12;
    weights[pc] += (s.end - s.start) * hopSec;
    sungSec += (s.end - s.start) * hopSec;
  }
  for (const n of opts.contextNotes || []) {
    weights[((Math.round(n.p) % 12) + 12) % 12] += n.d;
    sungSec += n.d;
  }
  let key = estimateKey(weights);
  if (key && (key.fit < 0.8 || sungSec < 1.5)) key = null; // too little evidence to act on
  const snap = key && opts.snapToScale !== false;

  let maxRms = 0;
  const raw = kept.map((s) => {
    let e = 0;
    for (let i = s.start; i < s.end; i++) e += rms[i];
    const lvl = e / (s.end - s.start);
    maxRms = Math.max(maxRms, lvl);
    const fl = median(s.vals);
    const d = (s.end - s.start) * hopSec;
    let p = Math.round(fl);
    if (snap && !key.scale.includes(((p % 12) + 12) % 12)) {
      // Out of key. Unless it was held long and dead on pitch, the singer meant a neighbour.
      const lean = fl - p;
      if (Math.abs(lean) >= 0.15 || d < 0.2) p += lean >= 0 ? 1 : -1;
    }
    return { t: s.start * hopSec, d, p, level: lvl, dip: s.dip };
  });

  // Merge touching notes that ended up on the same pitch (vibrato or a scoop across a boundary).
  const merged = [];
  for (const n of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.p === n.p && !n.dip && n.t - (prev.t + prev.d) < hopSec * 1.5) {
      prev.d = n.t + n.d - prev.t;
      prev.level = Math.max(prev.level, n.level);
      continue;
    }
    merged.push(n);
  }

  // A short slide into (or out of) a much longer neighbour is part of that note.
  const notes = [];
  for (let i = 0; i < merged.length; i++) {
    const n = merged[i];
    const prev = notes[notes.length - 1];
    const next = merged[i + 1];
    if (n.d < 0.1) {
      if (next && next.t - (n.t + n.d) < hopSec * 2.5 && Math.abs(next.p - n.p) <= 2 && next.d >= n.d * 2 && !next.dip) {
        next.d = next.t + next.d - n.t;
        next.t = n.t;
        next.dip = n.dip;
        continue;
      }
      if (prev && n.t - (prev.t + prev.d) < hopSec * 2.5 && Math.abs(prev.p - n.p) <= 2 && prev.d >= n.d * 2 && !n.dip) {
        prev.d = n.t + n.d - prev.t;
        continue;
      }
    }
    notes.push(n);
  }

  const round3 = (x) => Math.round(x * 1000) / 1000;
  return {
    detuneCents: Math.round(detune * 100),
    key: key ? { tonic: key.tonic, name: key.name } : null,
    notes: notes.map((n) => ({
      t: round3(n.t),
      d: round3(n.d),
      p: n.p,
      v: Math.round(Math.min(1, 0.45 + 0.55 * (maxRms ? n.level / maxRms : 1)) * 100) / 100,
    })),
  };
}

// ---- overdub latency ----

// Reference points on the metronome grid: beats, and (weaker) the eighths between them.
export function gridRefs(bpm, from, to) {
  const half = 30 / bpm;
  const out = [];
  for (let k = Math.floor(from / half) - 2; k * half <= to + 1; k++) out.push({ t: k * half, w: k % 2 === 0 ? 1 : 0.6 });
  return out;
}

// How late (seconds, positive = late) `onsets` are compared with reference points.
// Returns null when there is too little to go on.
export function estimateLag(onsets, refs, maxLag = 0.3) {
  if (onsets.length < 4 || !refs.length) return null;
  const sigma = 0.025;
  let best = null;
  for (let lag = -maxLag; lag <= maxLag + 1e-9; lag += 0.005) {
    let score = 0;
    for (const o of onsets) {
      let m = 0;
      for (const r of refs) {
        const d = o - lag - r.t;
        if (Math.abs(d) < 0.1) m = Math.max(m, r.w * Math.exp((-d * d) / (2 * sigma * sigma)));
      }
      score += m;
    }
    score *= 1 - (0.15 * Math.abs(lag)) / maxLag; // prefer the smaller correction on near-ties
    if (!best || score > best.score) best = { lag, score };
  }
  const residuals = [];
  for (const o of onsets) {
    let nearest = null;
    for (const r of refs) {
      const d = o - best.lag - r.t;
      if (Math.abs(d) <= 0.06 && (nearest == null || Math.abs(d) < Math.abs(nearest))) nearest = d;
    }
    if (nearest != null) residuals.push(nearest);
  }
  if (residuals.length < 4) return null;
  const med = median(residuals);
  const spread = median(residuals.map((x) => Math.abs(x - med)));
  return { lag: best.lag + med, matched: residuals.length, total: onsets.length, spread };
}

// Compare the first two takes. Each side: { onsets: [seconds], click: was the metronome on }.
// With a metronome both takes are measured against the beat; otherwise the second
// take is measured against the first. Returns { method, lag, matched, spread } or null.
export function measureLatency(bpm, first, second) {
  const ok = (r) => r && r.matched >= Math.max(5, r.total * 0.5) && r.spread <= 0.045;
  if (!first.onsets.length || !second.onsets.length) return null;
  if (first.click && second.click) {
    const all = first.onsets.concat(second.onsets);
    const refs = gridRefs(bpm, Math.min(...all), Math.max(...all));
    const a = estimateLag(first.onsets, refs);
    const b = estimateLag(second.onsets, refs);
    if (ok(a) && ok(b) && Math.abs(a.lag - b.lag) < 0.05) {
      return { method: 'grid', lag: (a.lag + b.lag) / 2, matched: a.matched + b.matched, spread: Math.max(a.spread, b.spread) };
    }
  }
  const p = estimateLag(second.onsets, first.onsets.map((t) => ({ t, w: 1 })));
  if (ok(p)) return { method: 'pair', lag: p.lag, matched: p.matched, spread: p.spread };
  return null;
}

// ---- click calibration ----

// Start times (seconds) of short sounds such as "ah" or a clap, found from loudness alone.
export function detectOnsets(samples, sampleRate) {
  const hop = Math.round(sampleRate * 0.005);
  const win = hop * 2;
  const n = Math.floor((samples.length - win) / hop);
  if (n <= 0) return [];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = 0; j < win; j++) e += samples[i * hop + j] * samples[i * hop + j];
    env[i] = Math.sqrt(e / win);
  }
  const peak = Array.from(env).sort((a, b) => a - b)[Math.floor(n * 0.98)];
  if (peak < 0.01) return [];
  const hi = peak * 0.3;
  const lo = peak * 0.1;
  const out = [];
  let armed = true;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    if (armed && env[i] > hi) {
      let j = i; // walk back to where the sound left the floor
      while (j > 0 && env[j - 1] > lo && i - j < 10) j--;
      const t = (j * hop) / sampleRate;
      if (!out.length || t - out[out.length - 1] > 0.15) out.push(t);
      armed = false;
      quiet = 0;
    } else if (!armed) {
      quiet = env[i] < lo ? quiet + 1 : 0;
      if (quiet >= 4) armed = true;
    }
  }
  return out;
}

// The user voiced along with metronome clicks. clickTimes: when each click should have
// landed in the recording (seconds from its start) if the delay setting were perfect.
// Returns { lag, matched, spread } (positive lag = the recording comes in late), or null.
export function measureClickLag(samples, sampleRate, clickTimes) {
  const onsets = detectOnsets(samples, sampleRate);
  const r = estimateLag(onsets, clickTimes.map((t) => ({ t, w: 1 })), 0.4);
  if (!r || r.matched < 4 || r.spread > 0.04) return null;
  return { lag: r.lag, matched: r.matched, spread: r.spread };
}
