import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  JapaneseSpeechSegmenter,
  cleanTextForSpeech,
  getUnstreamedReplyTail,
} from "../lib/shared/browser-tts";

describe("JapaneseSpeechSegmenter", () => {
  test("emits complete Japanese sentences while retaining expressive punctuation", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    assert.deepEqual(segmenter.append("おかえりなさい。今日も会えて"), ["おかえりなさい。"]) ;
    assert.deepEqual(segmenter.append("、うれしいです！元気ですか？"), [
      "今日も会えて、うれしいです！",
      "元気ですか？",
    ]);
    assert.deepEqual(segmenter.flush(), []);
  });

  test("keeps the closing quote with the sentence and handles ellipses", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    assert.deepEqual(segmenter.append("彼女は「また会おう。」と言った……次は"), [
      "彼女は「また会おう。」",
      "と言った……",
    ]);
    assert.deepEqual(segmenter.flush(), ["次は"]);
  });

  test("does not split on punctuation while a Japanese quote remains open", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    assert.deepEqual(
      segmenter.append("彼女は「本当？ まだ信じられない」と言った。"),
      ["彼女は「本当？ まだ信じられない」と言った。"],
    );
    assert.deepEqual(segmenter.append("えっ！？ 本当？"), ["えっ！？", "本当？"]);
  });

  test("treats newlines as boundaries and does not emit a streaming half-sentence", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    assert.deepEqual(segmenter.append("一行目です\n二行目はまだ"), ["一行目です"]);
    assert.deepEqual(segmenter.append("続きます"), []);
    assert.deepEqual(segmenter.flush(), ["二行目はまだ続きます"]);
  });

  test("splits a long punctuation-free sentence at a natural comma", () => {
    const segmenter = new JapaneseSpeechSegmenter({
      longSegmentLength: 24,
      minimumSegmentLength: 1,
    });
    const output = segmenter.append("これはとても長い説明なので、聞き取りやすい場所でいったん区切ってから続きを話します");
    assert.ok(output.length >= 1);
    assert.match(output[0], /、$/u);
    assert.equal(
      [...output, ...segmenter.flush()].join(""),
      "これはとても長い説明なので、聞き取りやすい場所でいったん区切ってから続きを話します",
    );
  });

  test("merges tiny fragments instead of making choppy requests", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 4 });
    assert.deepEqual(segmenter.append("はい。次です。"), ["はい。次です。"]);
  });

  test("does not let a late comma stretch a punctuation-free segment far beyond its limit", () => {
    const segmenter = new JapaneseSpeechSegmenter({
      longSegmentLength: 52,
      minimumSegmentLength: 1,
    });
    const output = segmenter.append(`${"あ".repeat(80)}、続きです。`);
    assert.ok(output.length >= 1);
    assert.ok([...output[0]].length <= 52);
    assert.equal([...output, ...segmenter.flush()].join(""), `${"あ".repeat(80)}、続きです。`);
  });

  test("keeps a short newline boundary when merging it with the next sentence", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 4 });
    assert.deepEqual(segmenter.append("はい\n次です。"), ["はい\n次です。"]);
  });
});

describe("getUnstreamedReplyTail", () => {
  test("returns only a final suffix and never repeats a mismatched completion", () => {
    assert.equal(getUnstreamedReplyTail("最初です。", "最初です。続きです。"), "続きです。");
    assert.equal(getUnstreamedReplyTail("", "全文です。"), "全文です。");
    assert.equal(getUnstreamedReplyTail("別の文です。", "完成文です。"), "");
  });
});

describe("cleanTextForSpeech", () => {
  test("removes Markdown controls, fenced code, URLs and citations from the TTS copy", () => {
    const source = [
      "## ご案内",
      "**今日は** [こちら](https://example.test/path) を見てね。[12]",
      "```ts",
      "const secret = 'not spoken';",
      "```",
      "直接URL https://example.test/private も読みません。",
    ].join("\n");
    const cleaned = cleanTextForSpeech(source);
    assert.match(cleaned, /^ご案内/u);
    assert.match(cleaned, /今日は こちら を見てね。/u);
    assert.match(cleaned, /直接URL も読みません。/u);
    assert.doesNotMatch(cleaned, /https|secret|```|\[12\]|\*\*/u);
  });

  test("leaves Japanese text and punctuation intact", () => {
    assert.equal(
      cleanTextForSpeech("「えへへ、ちょっと照れちゃいます。」"),
      "「えへへ、ちょっと照れちゃいます。」",
    );
  });

  test("does not swallow Japanese sentences immediately following a bare URL", () => {
    assert.equal(
      cleanTextForSpeech("詳細は https://example.test/path。次です！"),
      "詳細は 。次です！",
    );
  });

  test("does not speak fenced code or split a URL at its query marker", () => {
    const segmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    const markdown = "回答です。\n```js\nconsole.log(\"x\");\n```\n次です。";
    assert.deepEqual(
      [...segmenter.append(markdown), ...segmenter.flush()],
      ["回答です。", "次です。"],
    );

    const urlSegmenter = new JapaneseSpeechSegmenter({ minimumSegmentLength: 1 });
    assert.deepEqual(
      [...urlSegmenter.append("詳細は https://example.test/path?q=a。次です。"), ...urlSegmenter.flush()],
      ["詳細は 。", "次です。"],
    );
  });
});
