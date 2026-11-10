---
name: humming
description: 鼻歌をブラウザで録音して楽器のノート（MIDI 相当）に変換し、重ね録りで曲を組み立てて MP3 / WAV / MIDI に書き出す。ユーザーが「鼻歌から曲を作りたい」「鼻歌を録音したい」「ハミングを MIDI にしたい」「さっきの鼻歌の楽器を変えて／ハモリを足して／MP3 にして」などと言ったときに使う。録音ページの起動、project.json の編集による楽器変更・補正・伴奏追加、書き出しまでを扱う。
---

# Humming Notes

鼻歌を録音して楽器の演奏に変換し、重ね録りで曲にするスキル。役割分担は次のとおり。

- **ブラウザのページ**: マイク録音、音程解析（鼻歌 → ノート）、再生、重ね録り、ピアノロールでの手直し、MP3 / WAV のレンダリング。
- **ローカルサーバー**（`scripts/humming.mjs`、依存なしの Node 18+）: ページの配信、`project.json` の保存、楽器音色のダウンロードとキャッシュ、書き出しファイルの保存。
- **Claude（あなた）**: サーバーの起動、ユーザーの言葉を受けて `project.json` を直接編集（楽器の指定、移調、クオンタイズ、音の修正、ハモリや伴奏トラックの作曲）、書き出しコマンドの実行。

ページと Claude は同じ `project.json` を共有する。Claude がファイルを書き換えると、ページは約 1.5 秒以内に自動で読み込み直す。

## 起動

スクリプトはこの SKILL.md と同じフォルダの `scripts/humming.mjs`。バックグラウンドで起動する（`run_in_background: true`）。

```bash
node "${CLAUDE_SKILL_DIR}/scripts/humming.mjs" serve --project "<プロジェクトフォルダ>" --open
```

- `--project` は曲ごとのフォルダ。省略時はカレントの `humming-projects/default`。ユーザーが曲名を言ったら `humming-projects/<曲名>` にする。
- `--open` で既定のブラウザに `http://localhost:4173/` が開く。ポートを変えるときは `--port`（以降のコマンドにも同じ `--port` を付ける）。
- 「ポートは使用中」と出たら、すでに起動済みの可能性が高い。`status` で確認し、同じプロジェクトならそのまま使う。
- マイクの許可はユーザーがブラウザで行う。Claude が代わりに録音することはできない。

起動したらユーザーに次を短く伝える。

1. 「次の録音の楽器」を選び（Claude に言ってもよい）、「● 録音」を押す。カウントインのあと鼻歌を歌い、もう一度押すとノートに変換される。
2. 「▶ 再生」で確認。もう一度「● 録音」を押すと、今ある演奏を聞きながら次のパートを重ねられる。重ね録りはヘッドホン推奨。
3. 直したいことや足したいパートは Claude に言葉で頼める。最後に「MP3 にして」で書き出せる。

## 状態を見る

```bash
node "${CLAUDE_SKILL_DIR}/scripts/humming.mjs" status
```

プロジェクトの場所、ページが開いているか、トラック一覧、書き出し済みファイルが JSON で返る。ノートの中身を見るときは `project.json` を直接読む。

## project.json の編集

ユーザーの依頼の大半は `project.json` の編集で応える。編集前に必ず最新のファイルを読む（ユーザーがページで録音や手直しをしている）。ユーザーが録音中のときはページ側が読み込みを待つので、編集してよい。

```jsonc
{
  "name": "曲名",            // 書き出しファイル名に使う
  "bpm": 100,                // メトロノーム、小節線、クオンタイズ、MIDI のテンポ
  "beatsPerBar": 4,
  "metronome": true,
  "countInBars": 1,          // 録音前のカウントイン小節数
  "latencyMs": 0,            // 重ね録りのずれ補正（録音が遅れて聞こえるなら増やす）
  "next": { "instrument": "flute" },   // 次の録音に使う楽器
  "tracks": [
    {
      "id": "t1",            // 一意。新規トラックは重複しない ID を付ける
      "name": "メロディ",
      "instrument": "flute", // 下記の楽器名。"voice" は録音した生声をそのまま鳴らす
      "volume": 0.8,         // 0〜1.5
      "mute": false,
      "transpose": 0,        // 半音単位。オクターブは ±12
      "quantize": 0,         // 1 拍の分割数。0=なし 1=4分 2=8分 3=3連 4=16分（鳴らすときだけ適用、元のノートは保持）
      "offsetMs": 0,         // トラック全体を前後にずらす
      "take": "takes/t1.wav",// 元の録音。消さない。Claude が作ったトラックは null
      "notes": [ { "t": 0.52, "d": 0.31, "p": 64, "v": 0.8 } ]
    }
  ]
}
```

- ノートの `t` は開始秒、`d` は長さ秒、`p` は MIDI ノート番号（60 = 中央のド）、`v` は強さ 0〜1。1 拍は `60 / bpm` 秒。
- **楽器名**は General MIDI の名前（`scripts/shared.mjs` の `GM_NAMES` にある 128 種）。よく使うもの: `acoustic_grand_piano` `electric_piano_1` `music_box` `vibraphone` `marimba` `church_organ` `accordion` `acoustic_guitar_nylon` `acoustic_guitar_steel` `electric_guitar_clean` `distortion_guitar` `acoustic_bass` `electric_bass_finger` `synth_bass_1` `violin` `cello` `string_ensemble_1` `choir_aahs` `trumpet` `trombone` `alto_sax` `clarinet` `flute` `ocarina` `whistle` `lead_1_square` `lead_2_sawtooth` `pad_2_warm` `koto` `shamisen` `steel_drums`。一覧にない名前を書くと簡易シンセ音になる。
- 音色は初回だけネットから取得し `~/.cache/humming-notes/` にキャッシュする。オフラインで未取得の楽器は簡易シンセ音になる。

### よくある依頼と編集

| 依頼 | 編集 |
| --- | --- |
| 「次はベースで録る」 | `next.instrument` を `acoustic_bass` などに |
| 「2 番目をバイオリンにして」 | そのトラックの `instrument` |
| 「オクターブ下げて」 | `transpose` を -12 |
| 「リズムを揃えて」 | `quantize` を 2 か 4。先に `bpm` が歌のテンポに合っているか確認する |
| 「外れた音を直して」 | `notes` の `p` を修正。調から外れた音、極端に短い音、オクターブ飛びを疑う |
| 「ハモリを足して」 | メロディのノートを複製し、調に合う 3 度・6 度へ移した新トラックを追加 |
| 「伴奏／ベース／コードを付けて」 | メロディから調とコード進行を推定し、小節に合わせた新トラックを作曲して追加 |
| 「重ね録りがずれる」 | そのトラックの `offsetMs` を調整。毎回ずれるなら `latencyMs` |

新しいトラックを作曲するときは、既存ノートの時間（秒）と `bpm` から拍・小節を割り出して合わせる。鼻歌がメトロノームなしで歌われていてテンポが合っていない場合は、ノートの間隔から `bpm` を推定して設定してから作る。編集後は何を変えたかを一言で伝え、再生して確認してもらう。

和音は同じトラックに同じ `t` のノートを並べればよい。

## 書き出し

```bash
node "${CLAUDE_SKILL_DIR}/scripts/humming.mjs" export mp3    # または wav
node "${CLAUDE_SKILL_DIR}/scripts/humming.mjs" midi --project "<プロジェクトフォルダ>"
```

- `export` は開いているページに音声をレンダリングさせ、`<プロジェクト>/exports/` に保存してパスを表示する。ページのタブが開いている必要がある。タイムアウトしたら、タブを前面にしてもらうか、ページの「MP3 書き出し」ボタンを押してもらう（同じ場所に保存され、ブラウザにもダウンロードされる）。
- `midi` はページ不要で `project.json` から直接作る。ミュート中のトラックは含まれない。`voice` トラックは検出済みノートとして出力される。
- 書き出したら保存先のパスをユーザーに伝える。

## うまくいかないとき

- **ノートが検出されない／音が違う**: マイクに近づき「ラ」「ナ」などではっきり歌ってもらう。息の多いハミングや周囲の雑音は苦手。スピーカーで伴奏を流しながらの録音は伴奏を拾うのでヘッドホンにする。
- **Bluetooth ヘッドホンで大きくずれる**: 遅延が大きい。有線にするか `latencyMs` を 150〜250 程度に上げる。
- **ページが「外部で更新された」と言う**: 正常。Claude の編集を読み込んだだけ。
- **解析ロジックの確認**: `node "${CLAUDE_SKILL_DIR}/scripts/selftest.mjs"` で合成した鼻歌に対する変換テストが走る。
