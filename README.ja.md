# humming-notes

[English](README.md) | 日本語

鼻歌から曲を作る Claude Code スキル（プラグイン）です。

1. ブラウザのページで鼻歌を録音する
2. 指定した楽器のノート（MIDI 相当）に変換される
3. それを鳴らしながら別のパートを重ね録りする
4. Claude に「清書して」と頼むと、歌った音程の動きを読み直して丁寧に変換し直す。「下書き録音」をオンにすると生声のまま重ねていき、最後に「まとめて変換して」で全パートを見比べて変換できる
5. Claude に「ベースにして」「ハモリを足して」などと頼んで整える
6. MP3 / WAV / MIDI に書き出す

音源セットの切り替え、リバーブ、パートごとの左右の定位もページで調整でき、書き出しにも反映されます。

基本操作はブラウザ、丁寧な変換と編曲は Claude Code、という分担です。録音の遅延は「遅延を計測」で測れます。クリックに合わせて「あ」と声を出すだけで、結果はブラウザに記憶されます。ページ内の変換は即時の下書きで、清書前のノートはいつでも戻せます。

## インストール

```
/plugin marketplace add dala00/humming-notes
/plugin install humming-notes@humming-notes
```

インストールせずに試すなら、このリポジトリをクローンして `claude --plugin-dir plugins/humming-notes` でも読み込めます。
その後 Claude Code で「鼻歌で曲を作りたい」と言うか `/humming-notes:humming` を実行します。

## 必要なもの

- Node.js 18 以上（追加の npm パッケージは不要）
- Chrome / Edge などのブラウザとマイク。重ね録りはヘッドホン推奨
- 楽器の音色は初回だけ [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)（MusyngKite ほか）から取得し、`~/.cache/humming-notes/` にキャッシュします

## 言語

ページは英語で表示され、ブラウザの言語が日本語なら日本語になります。ページ右上の「言語」で切り替えられ、選んだ言語はブラウザに記憶されます。

コマンドのメッセージも同じようにシステムの言語に従います。`HUMMING_LANG=ja`（または `en`）か `--lang ja` で指定できます。

文言はすべて `scripts/i18n.mjs` にあります。英語が基準で、ほかの言語にないキーは英語で表示されます。

## 構成

```
plugins/humming-notes/skills/humming/
  SKILL.md              Claude 向けの手順と project.json の仕様
  scripts/humming.mjs   ローカルサーバー兼 CLI（serve / status / export / midi / curve / set-notes / restore / latency）
  scripts/analyze.mjs   鼻歌 → ノート変換（YIN 法による音程検出）
  scripts/shared.mjs    楽器一覧、クオンタイズ、MIDI ファイル生成
  scripts/i18n.mjs      ページと CLI の文言（英語と日本語）
  scripts/selftest.mjs  変換ロジックのテスト（node selftest.mjs）
  web/                  録音・再生・書き出しを行うページ
```

手動で起動する場合:

```
node plugins/humming-notes/skills/humming/scripts/humming.mjs serve --open
```

曲のデータはカレントフォルダの `humming-projects/<名前>/` に保存されます（`project.json`、元の録音 `takes/`、書き出し `exports/`）。変更は自動で保存されます。

曲はページの上部で管理できます。「曲」の一覧で切り替え、「新しい曲」で空の曲を作成、「複製」で録音ごとコピー、「名前を変更」でフォルダ名ごと改名します。起動時は最後に開いた曲が開きます。曲の削除はページにはないので、不要になったらフォルダを消してください。

## プライバシー

すべて手元のマシンで動きます。サーバーは `127.0.0.1` だけで待ち受け、録音と曲のデータは `humming-projects/` フォルダに残ります。ツール自体が行う通信は、上記の音源サイトからの楽器音色のダウンロードだけです。Claude Code が手伝うときに読む内容（ノートのデータ、CLI が出力する音高曲線）は、ほかの Claude Code の会話と同じ扱いになります。

## ライセンスとクレジット

このリポジトリのコードは [MIT ライセンス](LICENSE) で公開しています。

- `web/vendor/lame.min.js` は MP3 エンコーダーの [lamejs](https://github.com/zhuker/lamejs) 1.2.1 で、LGPL です。無改変で同梱しています。
- 楽器の音色は [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) から実行時に取得するもので、このリポジトリには含まれません。音源セットごとにライセンスがあります。FluidR3 は CC BY 3.0、MusyngKite と FatBoy は CC BY-SA 3.0 です。これらの音源で作った曲を公開する前に、その条件を確認してください。
