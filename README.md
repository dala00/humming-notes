# humming-notes

鼻歌から曲を作る Claude Code スキル（プラグイン）です。

1. ブラウザのページで鼻歌を録音する
2. 指定した楽器のノート（MIDI 相当）に変換される
3. それを鳴らしながら別のパートを重ね録りする
4. Claude に「ベースにして」「ハモリを足して」などと頼んで整える
5. MP3 / WAV / MIDI に書き出す

## インストール

```
/plugin marketplace add D:\users\documents\www\mine\humming-notes
/plugin install humming-notes@humming-notes
```

試すだけなら `claude --plugin-dir plugins/humming-notes` でも読み込めます。
その後 Claude Code で「鼻歌で曲を作りたい」と言うか `/humming-notes:humming` を実行します。

## 必要なもの

- Node.js 18 以上（追加の npm パッケージは不要）
- Chrome / Edge などのブラウザとマイク。重ね録りはヘッドホン推奨
- 楽器の音色は初回だけ [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)（FluidR3_GM）から取得し、`~/.cache/humming-notes/` にキャッシュします

## 構成

```
plugins/humming-notes/skills/humming/
  SKILL.md              Claude 向けの手順と project.json の仕様
  scripts/humming.mjs   ローカルサーバー兼 CLI（serve / status / export / midi）
  scripts/analyze.mjs   鼻歌 → ノート変換（YIN 法による音程検出）
  scripts/shared.mjs    楽器一覧、クオンタイズ、MIDI ファイル生成
  scripts/selftest.mjs  変換ロジックのテスト（node selftest.mjs）
  web/                  録音・再生・書き出しを行うページ
```

手動で起動する場合:

```
node plugins/humming-notes/skills/humming/scripts/humming.mjs serve --open
```

曲のデータはカレントフォルダの `humming-projects/<名前>/` に保存されます（`project.json`、元の録音 `takes/`、書き出し `exports/`）。
