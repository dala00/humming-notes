// Shared between the Node server/CLI and the browser page (served as /lib/shared.mjs).

// General MIDI program names (index = program number). Matches the soundfont file names.
export const GM_NAMES = ["acoustic_grand_piano","bright_acoustic_piano","electric_grand_piano","honkytonk_piano","electric_piano_1","electric_piano_2","harpsichord","clavinet","celesta","glockenspiel","music_box","vibraphone","marimba","xylophone","tubular_bells","dulcimer","drawbar_organ","percussive_organ","rock_organ","church_organ","reed_organ","accordion","harmonica","tango_accordion","acoustic_guitar_nylon","acoustic_guitar_steel","electric_guitar_jazz","electric_guitar_clean","electric_guitar_muted","overdriven_guitar","distortion_guitar","guitar_harmonics","acoustic_bass","electric_bass_finger","electric_bass_pick","fretless_bass","slap_bass_1","slap_bass_2","synth_bass_1","synth_bass_2","violin","viola","cello","contrabass","tremolo_strings","pizzicato_strings","orchestral_harp","timpani","string_ensemble_1","string_ensemble_2","synth_strings_1","synth_strings_2","choir_aahs","voice_oohs","synth_choir","orchestra_hit","trumpet","trombone","tuba","muted_trumpet","french_horn","brass_section","synth_brass_1","synth_brass_2","soprano_sax","alto_sax","tenor_sax","baritone_sax","oboe","english_horn","bassoon","clarinet","piccolo","flute","recorder","pan_flute","blown_bottle","shakuhachi","whistle","ocarina","lead_1_square","lead_2_sawtooth","lead_3_calliope","lead_4_chiff","lead_5_charang","lead_6_voice","lead_7_fifths","lead_8_bass__lead","pad_1_new_age","pad_2_warm","pad_3_polysynth","pad_4_choir","pad_5_bowed","pad_6_metallic","pad_7_halo","pad_8_sweep","fx_1_rain","fx_2_soundtrack","fx_3_crystal","fx_4_atmosphere","fx_5_brightness","fx_6_goblins","fx_7_echoes","fx_8_scifi","sitar","banjo","shamisen","koto","kalimba","bagpipe","fiddle","shanai","tinkle_bell","agogo","steel_drums","woodblock","taiko_drum","melodic_tom","synth_drum","reverse_cymbal","guitar_fret_noise","breath_noise","seashore","bird_tweet","telephone_ring","helicopter","applause","gunshot"];

// Instruments offered in the page's dropdown. Any GM_NAMES entry is valid in project.json.
// Labels are the English ones; i18n.mjs has the other languages.
export const INSTRUMENT_CHOICES = [
  ['acoustic_grand_piano', 'Piano'],
  ['electric_piano_1', 'Electric piano'],
  ['music_box', 'Music box'],
  ['vibraphone', 'Vibraphone'],
  ['marimba', 'Marimba'],
  ['church_organ', 'Pipe organ'],
  ['accordion', 'Accordion'],
  ['acoustic_guitar_nylon', 'Nylon guitar'],
  ['acoustic_guitar_steel', 'Acoustic guitar'],
  ['electric_guitar_clean', 'Electric guitar'],
  ['distortion_guitar', 'Distortion guitar'],
  ['acoustic_bass', 'Upright bass'],
  ['electric_bass_finger', 'Electric bass'],
  ['synth_bass_1', 'Synth bass'],
  ['violin', 'Violin'],
  ['cello', 'Cello'],
  ['string_ensemble_1', 'Strings'],
  ['choir_aahs', 'Choir'],
  ['trumpet', 'Trumpet'],
  ['trombone', 'Trombone'],
  ['alto_sax', 'Alto sax'],
  ['clarinet', 'Clarinet'],
  ['flute', 'Flute'],
  ['ocarina', 'Ocarina'],
  ['whistle', 'Whistle'],
  ['lead_1_square', 'Synth lead (square)'],
  ['lead_2_sawtooth', 'Synth lead (sawtooth)'],
  ['pad_2_warm', 'Synth pad'],
  ['koto', 'Koto'],
  ['shamisen', 'Shamisen'],
  ['steel_drums', 'Steel drums'],
  ['voice', 'Voice (as recorded)'],
];

// Sample sets the server can fetch (all General MIDI, same instrument names).
export const SOUNDFONTS = [
  ['MusyngKite', 'High quality (MusyngKite)'],
  ['FluidR3_GM', 'Standard (FluidR3)'],
  ['FatBoy', 'FatBoy'],
];

export function instrumentLabel(name) {
  const hit = INSTRUMENT_CHOICES.find(([n]) => n === name);
  return hit ? hit[1] : name;
}

export function isKnownInstrument(name) {
  return name === 'voice' || GM_NAMES.includes(name);
}

export function defaultProject(name = 'humming') {
  return {
    version: 1,
    name,
    bpm: 100,
    beatsPerBar: 4,
    metronome: true,
    countInBars: 1,
    latencyMs: 0,
    snapToScale: true,
    draft: false,
    latencyCalibrated: false,
    soundfont: 'MusyngKite',
    reverb: 0.2, // 0 = dry, 0.6 = very wet
    reverbTime: 1.8, // seconds for the tail to die away
    next: { instrument: 'acoustic_grand_piano' },
    tracks: [],
  };
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function cleanNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((n) => ({
      t: Number(n.t),
      d: Number(n.d),
      p: Math.round(Number(n.p)),
      v: n.v == null ? 0.8 : Number(n.v),
    }))
    .filter((n) => isFinite(n.t) && isFinite(n.d) && isFinite(n.p) && n.d > 0)
    .sort((a, b) => a.t - b.t);
}

// Fill in missing fields so a hand-edited file never crashes the page.
export function normalizeProject(p) {
  const d = defaultProject();
  const out = { ...d, ...(p && typeof p === 'object' ? p : {}) };
  out.bpm = clamp(Number(out.bpm) || d.bpm, 30, 300);
  out.beatsPerBar = clamp(Math.round(Number(out.beatsPerBar) || 4), 1, 12);
  out.countInBars = clamp(Math.round(Number(out.countInBars) || 0), 0, 4);
  out.metronome = !!out.metronome;
  out.snapToScale = out.snapToScale !== false;
  out.draft = !!out.draft;
  out.latencyCalibrated = !!out.latencyCalibrated;
  if (!SOUNDFONTS.some(([n]) => n === out.soundfont)) out.soundfont = d.soundfont;
  out.reverb = clamp(out.reverb == null ? d.reverb : Number(out.reverb) || 0, 0, 1);
  out.reverbTime = clamp(Number(out.reverbTime) || d.reverbTime, 0.3, 6);
  out.latencyMs = Number(out.latencyMs) || 0;
  out.next = { instrument: 'acoustic_grand_piano', ...(out.next || {}) };
  out.tracks = (Array.isArray(out.tracks) ? out.tracks : []).map((t, i) => ({
    id: String(t.id || `t${i + 1}`),
    name: String(t.name || `Track ${i + 1}`),
    instrument: String(t.instrument || 'acoustic_grand_piano'),
    volume: t.volume == null ? 0.8 : clamp(Number(t.volume) || 0, 0, 1.5),
    mute: !!t.mute,
    transpose: Math.round(Number(t.transpose) || 0),
    quantize: Math.round(Number(t.quantize) || 0),
    offsetMs: Number(t.offsetMs) || 0,
    pan: clamp(Number(t.pan) || 0, -1, 1), // -1 left .. 1 right
    humanize: clamp(Number(t.humanize) || 0, 0, 1), // small timing and loudness variation
    take: t.take || null,
    // Draft takes play back as the raw voice; this is the instrument they should become.
    planned: t.planned ? String(t.planned) : null,
    // Whether the metronome was on while this take was recorded (null = unknown).
    click: t.click == null ? null : !!t.click,
    notes: cleanNotes(t.notes),
    // The notes as they were before Claude's clean-up pass, so it can be undone.
    original: Array.isArray(t.original) ? cleanNotes(t.original) : null,
  }));
  return out;
}

// Repeatable pseudo-random value in -1..1, so playback, export and MIDI all agree.
function jitter(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// Notes as they should sound: offset, quantize, transpose and humanize applied.
// Each returned note carries `src`, its index in track.notes.
export function effectiveNotes(project, track) {
  const off = (track.offsetMs || 0) / 1000;
  const q = track.quantize || 0;
  const grid = q > 0 ? 60 / project.bpm / q : 0;
  const out = [];
  track.notes.forEach((n, src) => {
    let t = n.t + off;
    let end = t + n.d;
    if (grid) {
      t = Math.round(t / grid) * grid;
      end = Math.max(t + grid, Math.round(end / grid) * grid);
    }
    if (end <= 0) return;
    if (t < 0) t = 0;
    const p = clamp(n.p + (track.transpose || 0), 0, 127);
    let v = n.v == null ? 0.8 : n.v;
    const h = track.humanize || 0;
    if (h) {
      t = Math.max(0, t + jitter(src * 2 + 1) * 0.012 * h);
      v *= 1 + jitter(src * 2 + 2) * 0.18 * h;
    }
    out.push({ t, d: Math.max(0.02, end - t), p, v: clamp(v, 0.05, 1), src });
  });
  out.sort((a, b) => a.t - b.t);
  if (grid) {
    // Quantizing a sung line can make neighbours overlap slightly; clip them.
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (b.t > a.t && a.t + a.d > b.t && a.t + a.d < b.t + grid * 1.01) a.d = b.t - a.t;
    }
  }
  return out;
}

export function songDuration(project, takeDurations = {}) {
  let end = 0;
  for (const tr of project.tracks) {
    if (tr.instrument === 'voice') {
      const d = takeDurations[tr.id];
      if (d) end = Math.max(end, d + (tr.offsetMs || 0) / 1000);
    }
    for (const n of effectiveNotes(project, tr)) end = Math.max(end, n.t + n.d);
  }
  return end;
}

// ---- Standard MIDI File (format 1) ----

function vlq(n) {
  n = Math.max(0, Math.round(n));
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function chunk(tag, data) {
  const len = data.length;
  return [...tag]
    .map((c) => c.charCodeAt(0))
    .concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], data);
}

function utf8(str) {
  return Array.from(new TextEncoder().encode(str));
}

export function buildMidi(project) {
  const PPQ = 480;
  const toTicks = (sec) => Math.round((sec * project.bpm * PPQ) / 60);
  const usPerBeat = Math.round(60000000 / project.bpm);
  const tracks = [];

  const name0 = utf8(project.name || 'humming');
  tracks.push(
    [0, 0xff, 0x03, ...vlq(name0.length), ...name0]
      .concat([0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255])
      .concat([0, 0xff, 0x58, 4, project.beatsPerBar, 2, 24, 8])
      .concat([0, 0xff, 0x2f, 0])
  );

  let ch = 0;
  for (const tr of project.tracks) {
    if (tr.mute) continue;
    const notes = effectiveNotes(project, tr);
    if (!notes.length) continue;
    if (ch % 16 === 9) ch++; // channel 10 is percussion
    const channel = ch % 16;
    ch++;
    let program = GM_NAMES.indexOf(tr.instrument);
    if (program < 0) program = tr.instrument === 'voice' ? 53 : 0;
    const events = [];
    for (const n of notes) {
      const vel = clamp(Math.round(n.v * (tr.volume ?? 0.8) * 127), 1, 127);
      const on = toTicks(n.t);
      const off = Math.max(on + 1, toTicks(n.t + n.d));
      events.push({ tick: on, order: 1, bytes: [0x90 | channel, n.p, vel] });
      events.push({ tick: off, order: 0, bytes: [0x80 | channel, n.p, 0] });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const nm = utf8(tr.name || tr.instrument);
    let data = [0, 0xff, 0x03, ...vlq(nm.length), ...nm, 0, 0xc0 | channel, program];
    data = data.concat([0, 0xb0 | channel, 10, clamp(Math.round(64 + (tr.pan || 0) * 63), 0, 127)]);
    let last = 0;
    for (const e of events) {
      data = data.concat(vlq(e.tick - last), e.bytes);
      last = e.tick;
    }
    data = data.concat([0, 0xff, 0x2f, 0]);
    tracks.push(data);
  }

  let bytes = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  for (const t of tracks) bytes = bytes.concat(chunk('MTrk', t));
  return new Uint8Array(bytes);
}
