# humming-notes

鼻歌から曲を作る Claude Code プラグイン。ブラウザで鼻歌を録音して楽器のノートに変換し、重ね録りして MP3 / WAV / MIDI に書き出す。このリポジトリはプラグインを 1 つ持つマーケットプレイスでもある。

使い方（スキルを使う側の手順、`project.json` の仕様、清書や音作りの判断基準）は [SKILL.md](plugins/humming-notes/skills/humming/SKILL.md) が正。ここにはスキル自体を開発するときに必要なことだけを書く。

## 構成

```
.claude-plugin/marketplace.json            マーケットプレイス定義
plugins/humming-notes/.claude-plugin/      プラグイン定義
plugins/humming-notes/skills/humming/
  SKILL.md              Claude 向けの手順書（ユーザーに見える挙動を変えたら必ず更新）
  scripts/humming.mjs   ローカルサーバー兼 CLI
  scripts/analyze.mjs   鼻歌 → ノート変換、遅延計測（純粋関数）
  scripts/shared.mjs    プロジェクトの正規化、楽器一覧、実効ノート、MIDI 生成
  scripts/selftest.mjs  テスト
  web/                  録音・再生・書き出しページ（app.js が本体）
humming-projects/       曲データ。Git 管理外
```

役割分担は「即時性が要るものはブラウザ、判断が要るものは Claude、ファイルと外部取得はサーバー」。ページと Claude は `project.json` を共有し、Claude が書き換えるとページが約 1.5 秒で読み直す。

## コマンド

```bash
node plugins/humming-notes/skills/humming/scripts/selftest.mjs      # テスト。変更後は必ず通す
node plugins/humming-notes/skills/humming/scripts/humming.mjs serve --open
claude plugin validate .
```

npm 依存はない（Node 18 以上）。ビルドもない。`package.json` を足さないこと。

## 設計上の約束

- **`analyze.mjs` と `shared.mjs` はブラウザと Node の両方で動かす。** サーバーが `/lib/` として配信し、ページが import する。Node 専用 API や DOM を使わない。
- **再生と書き出しは同じ経路を通す。** `scheduleProject` と `buildMaster` を、実時間の `AudioContext` と `OfflineAudioContext` の両方で使う。片方だけに音の処理を足すと、聞いた音と書き出した音が食い違う。乱数を使う処理（リバーブの残響、揺らぎ）は種を固定して毎回同じ結果にする。
- **ノートの時刻は 2 種類ある。** `project.json` の `notes[].t` は録音基準（`offsetMs` 適用前）。CLI の `curve` の表示と `set-notes` の入力は曲の時刻（`offsetMs` 適用後）。実際に鳴る位置は `effectiveNotes()` が決めるので、再生・書き出し・MIDI は必ずこれを通す。
- **`normalizeProject()` が項目の番人。** 知らない項目は捨てられる。プロジェクトやトラックに項目を足すときは、既定値と正規化をここに書く。サーバーも保存時にこれを通すので、足し忘れるとページの保存で項目が消える。
- **元データを消さない。** 録音は `takes/` に残し、清書前のノートは `original` に退避する。ユーザーがいつでも戻せることを保つ。
- **書き出しはページが行う。** MP3 と WAV はブラウザでレンダリングしてサーバーに保存する。CLI の `export` は開いているページへの依頼なので、ページが閉じていると動かない。MIDI だけはサーバー単体で作れる。

## はまりどころ

- **サーバーは起動時に `scripts/*.mjs` を読み込む。** `humming.mjs` `shared.mjs` `analyze.mjs` を変えたらサーバーを再起動する。`web/` 以下と `/lib/` の配信は毎回ディスクから読むので、ページの再読み込みだけでよい。古いサーバーのまま新しい項目を保存すると、その項目が消える。
- **マイク録音は自動テストできない。** ページは `window.humming` を公開している。`addTake(Float32Array, サンプルレート, 開始秒, 楽器)` に合成した波形を渡すと、録音後と同じ経路を通せる。`renderMix()` のあと `mixPeak` で再生時のピークがわかる。実マイクでの確認はユーザーに頼む。
- **Claude は音を聞けない。** 音の変更はレベル、左右の相関、帯域ごとのエネルギーなど数値で確かめ、良し悪しはユーザーの感想で決める。ffmpeg と Python（numpy）が使える。
- **Bash ツールのヒアドキュメント**は、本文にアポストロフィが奇数個あると失敗することがある。長いパッチは Write でスクリプトをファイルに書いてから実行する。
- **Windows 環境。** サーバーを止めるときはポートから PID を引いて `taskkill` する。
- **音源は初回にネットから取得する。** `~/.cache/humming-notes/soundfonts/<セット>/<楽器>/` にキャッシュされる。取得できない楽器は簡易シンセ音になる。
- **`web/vendor/lame.min.js`** は LGPL の lamejs を無改変で同梱したもの。編集しない。

## 進め方

- ページの文言、スキルの説明、ユーザーへの返答は日本語。コード中のコメントは英語。
- 機能を足したら、`selftest.mjs` にテストを足し、Chrome で実際にページを動かして確かめる。
- ユーザーに見える挙動や `project.json` の項目を変えたら、同じコミットで SKILL.md と README.md を更新する。
- 区切りごとに `main` へコミットする。プッシュはしない。
- ユーザーの曲データを大きく書き換える前に、同じフォルダへ `project.json` をコピーして退避する。
