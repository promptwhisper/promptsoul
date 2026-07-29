<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul は会話の感情を Live2D モーションへ結び付け、安全な動作生成を行うローカル AI NPC です">
</p>

# PromptSoul

[简体中文](README.md) · [English](README.en.md) · 日本語

> [中国語 README](README.md) が完全な正本です。この日本語文書と表現が異なる場合は中国語版を参照してください。[English README](README.en.md) は英語の概要です。

PromptSoul は、会話の感情を Live2D モーションに結び付けるローカル AI NPC プロトタイプです。Next.js が応答をストリーミングし、日本語向けの分割処理が読み上げ可能な助手原文をローカル AivisSpeech Engine へ送ります。実際に再生中の Web Audio 振幅で Live2D の口パクを駆動し、プロンプトから現在のモデルが安全に表現できるモーションも生成できます。

**最初に読む:** [クイックスタート](#クイックスタート) · [AI Provider](#ai-provider) · [キャラクター音声](#キャラクター音声) · [プロンプトからモーション生成](#プロンプトからモーション生成) · [モデルの変更](#モデルの変更) · [ライセンス](#ライセンス)

<sub>デモキャラクター: Hiyori Momose ©Live2D（モデルデータはリポジトリに含まれません）</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## クイックスタート

サポート期間内の Node.js 22+ が必要です。Python は不要です。[Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html) と [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/learn/sample/model-terms/) を読んで同意した場合にのみ、明示的なフラグを付けて Hiyori をセットアップしてください。

```bash
npm ci
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
npm run dev
```

<http://127.0.0.1:8765> を開いてください。API Key が未設定なら、チャットは決定的なローカルデモ応答を使います。

## AI Provider

画面右上のパネルはサーバー設定の読み取り専用表示です。LLM API Key は Node サーバーの環境変数からのみ読み込み、ブラウザへ送信しません。ブラウザストレージ、Cookie、設定ファイル、ログ、レスポンス、Git にも保存しません。

常時運用ではサーバー環境変数を推奨します。

```bash
export NPC_API_KEY="your-key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="gpt-5.6-luna"
npm run dev
```

`gpt-5.6-luna` は PromptSoul の現在の既定 Provider モデル名であり、すべての OpenAI 互換サービスで利用できるとは限りません。Provider が実際に対応するモデルへ変更してください。

本番起動では先に `npm run build` を実行してから `npm start` を使ってください。

このアプリはローカルモデルを書き換え、プロセスメモリを利用するため、Node のセルフホスト環境で実行してください。Edge/Serverless ランタイム向けではありません。

## キャラクター音声

音声はローカル [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) のみを使用し、クラウド TTS Key は不要です。AivisSpeech を起動し、コハクの AIVMX モデルを自分で導入して「あまあま」スタイルを確認してください。モデルはリポジトリに含めず、利用者が各モデルのライセンスを確認する必要があります。

AivisHub に表示される Style ID `1` はモデル内部のローカル ID です。HTTP API の `speaker=1` として固定してはいけません。PromptSoul は `/speakers` から UUID・キャラクター名・スタイル名を照合し、現在の Engine が生成したグローバル Style ID を解決します。

```bash
# 既存 .env.local を上書きせず、.env.example の Aivis 設定を反映
npm run tts:check
npm run tts:smoke
npm run dev
```

公開されるサーバー境界は `GET /api/tts/status`、`GET /api/tts/voices`、`POST /api/tts` です。既存の `GET /api/status` にも `tts` フィールドが含まれます。ブラウザは同一オリジン API だけを呼び出し、Engine URL はサーバー専用です。

分割処理は日本語の句読点向けに最適化されていますが、言語判定や翻訳はしません。既定のペルソナは利用者と同じ言語で回答するため、日本語音声が必要なら日本語で入力するかペルソナを変更してください。画面に表示する原文は TTS 用に書き換えません。

単一の順序付きキューが `AudioBufferSourceNode → AnalyserNode → GainNode → AudioContext.destination` で再生し、GainNode から録画用 `MediaStreamAudioDestinationNode` にも分岐します。実音声 RMS をノイズゲートと平滑化に通し、実績のあるレガシーレンダラーの `beforeModelUpdate` で `model3.json` の `LipSync` パラメータを更新します。Hiyori は `ParamMouthOpenY` を使用します。TTS エラーが発生しても、テキスト会話と感情モーションは継続します。

ローカル WAV キャッシュには合成済みの会話音声が含まれます。共有端末や機密性の高い会話では `TTS_CACHE_ENABLED=false` を設定し、既存分は PromptSoul を停止してから `.cache/aivis-tts/` を削除してください。

TTS と口パクに絞った無人検証クリップを収録する場合は、macOS、Linux、または WSL 上で Chrome/Chromium、ffmpeg、ffprobe、Bash、`curl`、`seq` を用意して次を実行します。

```bash
npm run record:browser
```

このスクリプトは Next.js と独立した headless Chrome を起動し、`PromptSoulTTS.play()` を直接呼び出して CDP 連続フレームと同じ AudioContext の音声を収録します。チャット送信や LLM ストリームは検証しません。

収録開始前に `playing` 状態、実行中の AudioContext、進行する再生位置、非無音 RMS、Live2D の口パラメータ読取値の変化を確認します。これは音声からランタイムパラメータまでの経路を示しますが、ArtMesh 頂点の変形や見た目の分かりやすさを独立に証明するものではありません。終了時は ffprobe と一時的な 3 枚の JPEG が空でないことだけを自動確認します。フレームは作業ディレクトリと共に削除されるため、完成動画を目視確認してください。

既定出力は 720×1280 の `artifacts/promptsoul-unattended.mp4` です。`OUT`、`WIDTH`、`HEIGHT`、`PORT`、`CHROME`、`FFMPEG`、`FFPROBE`、`TTS_TEXT`、`RECORD_TIMEOUT_MS`、または `npm run record:browser -- --help` に表示される CLI オプションで変更できます。AivisSpeech、設定済み音声、実再生、口パラメータ変化を確認できない場合は明示的に失敗します。全環境変数、キャッシュ、トラブルシューティングは [中国語 README](README.md#接入角色语音) を参照してください。

## プロンプトからモーション生成

AI Provider とモデルを用意すると、自然言語の説明を現在のモデルの安全範囲内の曲線へコンパイルできます。サーバーは任意コード、未知の制御、物理出力、`PartOpacity`、範囲外値、不正なキーフレームを拒否し、生成結果をプロジェクト専用の `PromptSoul` グループだけに登録します。

保存された AI モーション ID は `promptsoul_ai_<12桁の16進数>` です。削除できるのは検証済みのこの形式だけで、成功時にも無視対象の定義ファイルが残ると `cleanupPending` が返る場合があります。組み込みモーションと `Action`、`Idle`、`Tap` などモデル固有グループは削除・上書きしません。現在文書化されている 7 種類の感情モーションは Hiyori 定義専用で、別モデルでは安全に使える種類が異なることがあります。

## モデルの変更

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
```

新しいモデルはまずインポートし、モーションを設計する前に分析結果を確認して、`motion-defs/<model>.ts` をそのモデル専用に作成してください。Hiyori のパラメーターを別モデルへコピーしてはいけません。

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

生成モーションは必ずプロジェクト専用の `PromptSoul` グループに登録され、元の `Action`、`Idle`、`Tap` などは上書きしません。React の `components/legacy-runtime.tsx` は固定バージョンの SDK と `assets/app.js` の実績ある単一 Live2D コントローラーを読み込みます。音声統合のために第二のコントローラーは作成していません。詳細な安全ルールと Agent 手順は [AGENTS.md](AGENTS.md) を参照してください。

## ライセンス

権利者が許諾できる本リポジトリのコードと文書は [MIT License](LICENSE) で提供され、上流の MIT 著作権表示も維持されます。このライセンスは Hiyori、Cubism Core、AivisSpeech、利用者が追加した Live2D/AIVMX モデルには適用されません。Hiyori を利用する前に [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html) と [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/learn/sample/model-terms/) を確認してください。Hiyori のデザインは変更できません。Hiyori を含むスクリーンショットとデモでは、`Hiyori Momose ©Live2D` と適用規約が要求する声明を画面内に見える形で保持してください。

Live2D Cubism Core は [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html) の対象です。AivisSpeech Engine は本リポジトリに含まず、上流の [GNU LGPL v3](https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/LICENSE) で配布されています。AIVMX 音声モデルはモデルごとに異なるライセンスを持つ場合があります。利用者自身が選択したモデルの規約を確認し、遵守してください。PromptSoul がモデル作者に代わって再許諾することはありません。

PromptSoul は [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) を基に拡張しています。

第三者ライセンスの詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、コントリビューション手順は [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性報告は [SECURITY.md](SECURITY.md) を参照してください。
