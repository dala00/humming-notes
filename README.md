# humming-notes

English | [日本語](README.ja.md)

A Claude Code skill (plugin) for making music by humming.

1. Record yourself humming on a page in the browser
2. The take is converted to notes (MIDI-like) for the instrument you chose
3. Overdub the next part while the earlier ones play
4. Ask Claude to "clean it up" and it re-reads how your pitch actually moved and converts the take again, carefully. With "Draft recording" on, the takes stay as your own voice and you ask Claude to "convert them all" at the end, so it can compare every part
5. Ask Claude for changes such as "make it a bass" or "add a harmony"
6. Export MP3 / WAV / MIDI

The page also lets you switch sample sets, add reverb and pan each part; exports include all of it.

The browser handles the hands-on work, Claude Code handles careful conversion and arranging. "Measure latency" measures the recording delay: you say "ah" along with a few clicks and the result is remembered in the browser. Conversion in the page is a quick draft, and the notes from before a clean-up can always be brought back.

## Install

```
/plugin marketplace add <path to this repository>
/plugin install humming-notes@humming-notes
```

To just try it, `claude --plugin-dir plugins/humming-notes` works too.
Then tell Claude Code "I want to make a song by humming" or run `/humming-notes:humming`.

## Requirements

- Node.js 18 or later (no npm packages needed)
- A browser such as Chrome or Edge, and a microphone. Headphones are recommended for overdubbing
- Instrument samples are fetched once from [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (MusyngKite and others) and cached in `~/.cache/humming-notes/`

## Language

The page is in English, or in Japanese when the browser's language is Japanese. The "Language" menu at the top right of the page switches it, and the choice is remembered in the browser.

Command-line messages follow the system language in the same way. `HUMMING_LANG=en` (or `ja`) or `--lang en` overrides it.

All text lives in `scripts/i18n.mjs`; English is the base, and a key missing from another language falls back to it.

## Layout

```
plugins/humming-notes/skills/humming/
  SKILL.md              Instructions for Claude and the project.json format (Japanese)
  scripts/humming.mjs   Local server and CLI (serve / status / export / midi / curve / set-notes / restore / latency)
  scripts/analyze.mjs   Humming → notes (pitch detection with the YIN method)
  scripts/shared.mjs    Instrument list, quantizing, MIDI file writer
  scripts/i18n.mjs      Text for the page and the CLI (English and Japanese)
  scripts/selftest.mjs  Tests (node selftest.mjs)
  web/                  The page that records, plays and exports
```

To start it by hand:

```
node plugins/humming-notes/skills/humming/scripts/humming.mjs serve --open
```

Songs are stored in `humming-projects/<name>/` under the current folder (`project.json`, the original recordings in `takes/`, exports in `exports/`). Changes are saved automatically.

Songs are managed at the top of the page: the "Song" list switches between them, "New song" creates an empty one, "Duplicate" copies the current song with its recordings, and "Rename" renames it together with its folder. The server opens the song that was open last. The page has no delete; remove the folder when a song is no longer needed.
