<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul — ローカルで動く AI Live2D NPC">
</p>

# PromptSoul

[简体中文](README.md) · [English](README.en.md) · 日本語

PromptSoul は、AI の会話・感情・音声を Live2D の表情やモーション、口パクへつなぐ、ローカル動作の Next.js プロトタイプです。

主な機能:

- OpenAI 互換チャット、API Key 不要のデモ会話、感情連動モーション
- 任意の DSH バックエンドによるリアルタイム会話と一時的な Live2D cue
- 自然言語からモデルに合った安全なモーションを生成・削除
- AivisSpeech によるローカル音声合成と、実際の音量に連動する口パク

<sub>デモキャラクター: Hiyori Momose ©Live2D（モデルデータはリポジトリに含まれません）</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## クイックスタート

Node.js 22.19 以上が必要です。Python は不要です。Hiyori の利用規約を確認し、同意した場合のみデモモデルをセットアップしてください。

```bash
npm ci
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
npm run dev
```

ブラウザで <http://127.0.0.1:8765> を開きます。LLM API Key が未設定でも、決定的なローカルデモ応答で動作を確認できます。

本番相当では `npm run build` の後に `npm start` で起動します。

## LLM の設定

`.env.example` を参考に `.env.local` を作成します。API Key は必ず Node サーバー側に置き、ブラウザや公開設定へ渡さないでください。

```dotenv
NPC_API_KEY=your-key
NPC_API_BASE=https://api.openai.com/v1
NPC_MODEL=provider-supported-model
```

`OPENAI_API_KEY` も API Key の代替変数として利用できます。`NPC_MODEL` には、利用する OpenAI 互換 Provider が実際に対応しているモデル名を指定してください。

## DSH リアルタイム会話（任意）

通常のチャット経路はそのまま利用できます。検証済みの発話セグメントと一時的な Live2D cue を同期させる場合は、`.env.local` に次を設定します。

```dotenv
CHAT_BACKEND=dsh-realtime
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DSH_MODEL=deepseek-v4-flash
```

各 NDJSON セグメントの本文は既存 TTS キューへ入り、cue は同じ AudioContext の時刻で実行されます。cue はブラウザのメモリだけに存在し、モーションファイルやモデルのグループを変更しません。Key と生の DSH イベントはサーバー側に残り、子プロセスへ渡す環境変数も許可リストに限定されます。`CHAT_BACKEND` を外すと従来の Provider／デモ経路へ戻ります。

DSH には、現在の Cubism Parameter／PartOpacity の生 ID、範囲、基準値と、リクエストに応じて選んだ最大 3 件の完全で未省略の既存 `.motion3.json` を渡します。リアルタイム cue は最大 40 曲線、各 64 キーに対応し、Hiyori `hiyori_m08` の全 35 曲線を小さなポーズ例へ縮約せず参照できます。`.moc3`、テクスチャ、API Key は渡しません。PartOpacity は主ポーズ曲線と同じ cue でのみ使用でき、再生後に元の値へ戻ります。

## ローカル音声（任意）

音声にはローカルの [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) を使います。クラウド TTS の API Key は不要です。

AivisSpeech を起動し、使用する AIVMX 音声モデルとスタイルを導入してから、`.env.example` の設定を `.env.local` に反映します。既定は `コハク / あまあま` です。

```dotenv
TTS_PROVIDER=aivis
AIVIS_BASE_URL=http://127.0.0.1:10101
AIVIS_SPEAKER_UUID=5680ac39-43c9-487a-bc3e-018c0d29cc38
AIVIS_SPEAKER_NAME=コハク
AIVIS_STYLE_NAME=あまあま
```

```bash
npm run tts:check
npm run tts:smoke
```

`tts:check` は現在の Engine から実際のグローバル Style ID を解決し、`tts:smoke` は `artifacts/tts-smoke.wav` を生成して WAV を検証します。AivisHub に表示されるモデル内部の Style ID `1` を `speaker=1` として固定しないでください。追加設定は [.env.example](.env.example) を参照してください。

TTS が利用できない場合も文字チャットと感情モーションは動作します。AIVMX モデルや生成 WAV は Git に追加しないでください。ローカル WAV キャッシュには会話が含まれる場合があり、`TTS_CACHE_ENABLED=false` で無効化、停止後に `.cache/aivis-tts/` を削除できます。

## プロンプト着せ替えと保存済み衣装

PromptSoul は [PromptSkin](https://github.com/promptwhisper/PromptSkin) と連携し、Prompt Wardrobe で衣装を文章から生成できます。生成済み衣装と元のテクスチャはいつでも切り替えられます。

PromptSkin バックエンドを起動し、PromptSoul の `.env.local` に次を設定します。画像 API Key は PromptSkin 側だけに置いてください。

```dotenv
PROMPTSKIN_API_BASE=http://127.0.0.1:8000
PROMPTSKIN_PROVIDER=openai
PROMPTSKIN_GENERATION_TIMEOUT_MS=720000
```

結果の `.model3.json`、`.moc3`、テクスチャ参照、画像サイズが現在のモデルと一致した場合だけ受け入れ、PNG テクスチャだけを切り替えます。UV、リグ、物理、パラメーター、モーションは変更しません。衣装は Git 対象外の `local-assets/wardrobe/` に保存されます。Hiyori はデザイン変更不可のため、この機能は自動的に無効になります。クラウド画像 Provider を使う場合、プロンプトと編集対象テクスチャがその Provider へ送信されます。

既存の PromptSkin ZIP も `npm run wardrobe:import -- /path/to/export.zip --name "衣装名"` でプリセット一覧へ追加できます。`--activate` を付けると導入後すぐに切り替えます。

## カスタムモデル

モデルのフォルダーまたは ZIP を読み込み、必ず分析してから専用モーションを作成します。

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

Hiyori のパラメーターを別モデルへ流用しないでください。生成モーションは `PromptSoul` グループだけに追加され、モデル本来の `Action`、`Idle`、`Tap` などは上書きしません。モデル固有の定義は `motion-defs/<model>.ts` に置きます。

## 検証

```bash
npm run verify
npm run motions:generate
npm run motions:validate
git diff --check
```

`npm run verify` はリポジトリ検査、型チェック、lint、テスト、`assets/app.js` の構文確認、production build を実行します。UI やモーションを変更した場合は `npm run verify:browser` も実行してください。

## セキュリティとライセンス

- LLM API Key はサーバー環境変数だけで管理し、ブラウザ、ログ、設定ファイル、Git に保存しないでください。
- この開発サーバーと変更系 API はローカル利用を前提としています。インターネットへ直接公開しないでください。
- `models/`、`local-assets/`、`model.config.json`、生成モーション定義、AIVMX、生成音声はコミットしないでください。
- Hiyori のデザインを変更せず、スクリーンショットやデモでは `Hiyori Momose ©Live2D` と必要な声明を表示してください。

本リポジトリが許諾できるコードと文書は [MIT License](LICENSE) で提供されます。これは Hiyori、Cubism Core、AivisSpeech、追加した Live2D/AIVMX モデルには適用されません。DeepSeek Harness パッケージは `0.1.0-rc.6` に固定されていますが、その MIT ライセンスは DeepSeek API やモデルサービスを許諾するものではありません。

Hiyori を利用する前に [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html) と [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/learn/sample/model-terms/) を確認してください。音声モデルにも個別のライセンスがあるため、利用者自身で確認し遵守してください。

PromptSoul は [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) を基に拡張しています。第三者ライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、開発への参加方法は [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性報告は [SECURITY.md](SECURITY.md) を参照してください。
