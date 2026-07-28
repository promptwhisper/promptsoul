<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul は会話の感情を Live2D モーションへ結び付け、安全な動作生成を行うローカル AI NPC です">
</p>

# PromptSoul

[简体中文](README.md) · [English](README.en.md) · 日本語

> この日本語文書はクイックスタートの要約です。完全な機能、安全境界、モーション削除、検証手順は [English README](README.en.md) を参照してください。

PromptSoul は、会話の感情を Live2D モーションに結び付ける、ローカル実行向けの AI NPC プロトタイプです。0.3 では AITuber OnAir Chat / Voice を統合し、任意の TTS 音声から Live2D の口パクも実行できます。Next.js の画面と Node API を一つのプロジェクトに統合し、プロンプトから現在のモデルが安全に表現できるモーションも生成できます。

**最初に読む:** [クイックスタート](#クイックスタート) · [AI Provider](#ai-provider) · [キャラクター音声](#キャラクター音声) · [モデルの変更](#モデルの変更) · [ライセンス](#ライセンス)

<sub>デモキャラクター: Hiyori Momose ©Live2D（モデルデータはリポジトリに含まれません）</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## クイックスタート

サポート期間内の Node.js 22+ が必要です。Python は不要です。Hiyori の利用規約を読んで同意した場合にのみ、明示的なフラグを付けてセットアップしてください。

```bash
npm ci
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
npm run dev
```

<http://127.0.0.1:8765> を開いてください。API Key が未設定なら、チャットは決定的なローカルデモ応答を使います。

## AI Provider

画面右上の設定から、OpenAI 互換 API の URL、モデル名、API Key を入力できます。Key は一度だけローカル Node API に送られ、現在の Node プロセスのメモリだけに保持されます。ブラウザストレージ、Cookie、設定ファイル、ログ、Git には保存せず、公開 API から読み戻すこともできません。サーバー再起動時に消去されます。

常時運用ではサーバー環境変数を推奨します。

```bash
export NPC_API_KEY="your-key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="gpt-5.6-luna"
npm start
```

`gpt-5.6-luna` は PromptSoul の現在の既定 Provider モデル名であり、すべての OpenAI 互換サービスで利用できるとは限りません。Provider が実際に対応するモデルへ変更してください。

このアプリはローカルモデルを書き換え、プロセスメモリを利用するため、Node のセルフホスト環境で実行してください。Edge/Serverless ランタイム向けではありません。

## キャラクター音声

音声設定はチャット Provider と独立しています。`@aituber-onair/voice` の OpenAI 互換エンジンで `/v1/audio/speech` を呼び出し、ブラウザの Web Audio が音量を解析して実行時の口パクを駆動します。音声 Key は Node プロセスのメモリだけに保持され、モデルやモーション定義は変更しません。TTS エラーが発生してもテキスト会話と感情モーションは継続します。

口パクには `model3.json` の `LipSync` グループで宣言されたパラメータを優先し、宣言がない場合のみ一般的な口パラメータ ID にフォールバックします。公式 Hiyori `.moc3` と Cubism Core 5.1.0 で検証し、`ParamMouthOpenY` が 0〜1 の範囲で更新・リセットされ、開口時に 6 個の ArtMesh、321 個の頂点座標が変形することを確認しています。

```bash
export NPC_TTS_ENABLED=\"true\"
export NPC_TTS_API_KEY=\"voice-key\"
export NPC_TTS_API_URL=\"https://api.openai.com/v1/audio/speech\"
export NPC_TTS_MODEL=\"gpt-4o-mini-tts\"
export NPC_TTS_SPEAKER=\"alloy\"
export NPC_TTS_SPEED=\"1\"
```

## モデルの変更

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
```

新しいモデルでは分析を先に実行し、`motion-defs/<model>.ts` をそのモデル専用に作成してください。Hiyori のパラメーターを別モデルへコピーしてはいけません。

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

生成モーションは必ずプロジェクト専用の `PromptSoul` グループに登録され、元の `Action`、`Idle`、`Tap` などは上書きしません。詳細な安全ルールと Agent 手順は [AGENTS.md](AGENTS.md) を参照してください。

## ライセンス

権利者が許諾できる本リポジトリのコードと文書は [MIT License](LICENSE) で提供され、上流の MIT 著作権表示も維持されます。このライセンスは Hiyori、Cubism Core、利用者が追加したモデルには適用されません。Hiyori を利用する前に [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html) と [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/learn/sample/model-terms/) を確認してください。Hiyori のデザインは変更できません。

PromptSoul は [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) を基に拡張しています。

第三者ライセンスの詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、コントリビューション手順は [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性報告は [SECURITY.md](SECURITY.md) を参照してください。
