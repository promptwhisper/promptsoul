import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { analyzeModel, formatModelAnalysis } from "../lib/server/model-analysis.ts";
import {
  extractHiyoriRuntimeArchive,
  LicenseAcceptanceError,
  setupHiyoriDemo,
} from "../lib/server/model-demo.ts";
import { setupModel } from "../lib/server/model-setup.ts";
import { extractZipArchive, ZipSafetyError } from "../lib/server/model-zip.ts";

interface FixtureEntry {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  unixMode?: number;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeZip(archivePath: string, entries: FixtureEntry[]): Promise<void> {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const flags = 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([localHeader, name, compressed]);
    localRecords.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    const defaultMode = entry.name.endsWith("/") ? 0o040755 : 0o100644;
    centralHeader.writeUInt32LE((((entry.unixMode ?? defaultMode) & 0xffff) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    offset += local.length;
  }

  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(archivePath, Buffer.concat([...localRecords, central, end]));
}

const TEST_LIMITS = {
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 100,
  maxExtractedBytes: 16 * 1024 * 1024,
};

test("safe ZIP extraction handles stored and deflated model files", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-zip-"));
  const archive = join(root, "model.zip");
  const output = join(root, "out");
  await writeZip(archive, [
    { name: "model/" },
    { name: "model/avatar.model3.json", data: "{}" },
    { name: "model/textures/texture_00.png", data: "png", method: 8 },
  ]);

  const extracted = await extractZipArchive(archive, output, TEST_LIMITS);
  assert.deepEqual(extracted, [
    "model",
    "model/avatar.model3.json",
    "model/textures/texture_00.png",
  ]);
  assert.equal(await readFile(join(output, "model/avatar.model3.json"), "utf8"), "{}");
  assert.equal(await readFile(join(output, "model/textures/texture_00.png"), "utf8"), "png");
});

test("safe ZIP extraction rejects parent traversal before writing outside", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-traversal-"));
  const archive = join(root, "bad.zip");
  const output = join(root, "out");
  await writeZip(archive, [{ name: "../escaped.txt", data: "nope" }]);

  await assert.rejects(extractZipArchive(archive, output, TEST_LIMITS), ZipSafetyError);
  await assert.rejects(stat(join(root, "escaped.txt")), { code: "ENOENT" });
});

test("safe ZIP extraction rejects backslashes, drive paths, and symbolic links", async (t) => {
  const cases: FixtureEntry[] = [
    { name: "model\\escaped.txt", data: "nope" },
    { name: "C:/escaped.txt", data: "nope" },
    { name: "model/link", data: "target", unixMode: 0o120777 },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const root = await mkdtemp(join(tmpdir(), `promptsoul-node-unsafe-${index}-`));
      const archive = join(root, "bad.zip");
      await writeZip(archive, [entry]);
      await assert.rejects(
        extractZipArchive(archive, join(root, "out"), TEST_LIMITS),
        ZipSafetyError,
      );
    });
  }
});

test("safe ZIP extraction enforces the selected uncompressed-byte limit before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-limit-"));
  const archive = join(root, "large.zip");
  const output = join(root, "out");
  await writeZip(archive, [{ name: "model/data.bin", data: "1234", method: 8 }]);
  await assert.rejects(
    extractZipArchive(archive, output, { ...TEST_LIMITS, maxExtractedBytes: 3 }),
    /extraction size limit/,
  );
  await assert.rejects(stat(join(output, "model", "data.bin")), { code: "ENOENT" });
});

test("setupModel extracts a ZIP, copies its runtime, and writes model.config.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-setup-"));
  const archive = join(root, "avatar.zip");
  await writeZip(archive, [
    { name: "bundle/avatar.model3.json", data: '{"Version":3}' },
    { name: "bundle/avatar.moc3", data: "moc" },
  ]);

  const result = await setupModel({ root, source: archive });
  assert.equal(result.name, "avatar");
  assert.equal(result.model3, "models/avatar/avatar.model3.json");
  assert.equal(await readFile(join(root, result.model3), "utf8"), '{"Version":3}');
  assert.deepEqual(JSON.parse(await readFile(join(root, "model.config.json"), "utf8")), {
    name: "avatar",
    model3: "models/avatar/avatar.model3.json",
  });
});

test("Hiyori extraction selects only the official runtime subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-hiyori-"));
  const archive = join(root, "hiyori.zip");
  const output = join(root, "runtime");
  await writeZip(archive, [
    { name: "hiyori_pro/runtime/hiyori_pro_t11.model3.json", data: "{}", method: 8 },
    { name: "hiyori_pro/runtime/texture.png", data: "png" },
    { name: "hiyori_pro/source/do-not-copy.cmo3", data: "source" },
  ]);

  const extracted = await extractHiyoriRuntimeArchive(archive, output);
  assert.deepEqual(extracted, ["hiyori_pro_t11.model3.json", "texture.png"]);
  assert.equal(await readFile(join(output, "hiyori_pro_t11.model3.json"), "utf8"), "{}");
  await assert.rejects(stat(join(output, "source", "do-not-copy.cmo3")), { code: "ENOENT" });
});

test("Hiyori setup requires explicit license acceptance before network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-license-"));
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("network must not be reached");
  };
  await assert.rejects(
    setupHiyoriDemo({ root, acceptLicense: false, fetchImpl: fetchImpl as typeof fetch }),
    LicenseAcceptanceError,
  );
  assert.equal(fetched, false);
});

test("Hiyori setup is idempotent and reuses an already configured model", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-demo-ready-"));
  const model = join(root, "models", "hiyori_pro_t11", "hiyori_pro_t11.model3.json");
  await mkdir(join(root, "models", "hiyori_pro_t11"), { recursive: true });
  await writeFile(model, "{}");
  await writeFile(
    join(root, "model.config.json"),
    JSON.stringify({
      name: "hiyori_pro_t11",
      model3: "models/hiyori_pro_t11/hiyori_pro_t11.model3.json",
    }),
  );
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("network must not be reached");
  };
  const result = await setupHiyoriDemo({
    root,
    acceptLicense: true,
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.deepEqual(result, { alreadyConfigured: true, reusedDownload: true });
  assert.equal(fetched, false);
});

test("analyzeModel reports source motion ranges and excludes PromptSoul output", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptsoul-node-analyze-"));
  const runtime = join(root, "models", "avatar");
  await mkdir(join(runtime, "motion"), { recursive: true });
  await writeFile(
    join(root, "model.config.json"),
    JSON.stringify({ name: "avatar", model3: "models/avatar/avatar.model3.json" }),
  );
  await writeFile(
    join(runtime, "avatar.model3.json"),
    JSON.stringify({
      FileReferences: {
        Motions: { PromptSoul: [{ File: "motion/generated.motion3.json" }] },
      },
    }),
  );
  await writeFile(
    join(runtime, "avatar.cdi3.json"),
    JSON.stringify({
      Parameters: [
        { Id: "ParamAngleX", Name: "Head X" },
        { Id: "ParamHair", Name: "Hair" },
      ],
    }),
  );
  await writeFile(
    join(runtime, "avatar.physics3.json"),
    JSON.stringify({
      PhysicsSettings: [{ Output: [{ Destination: { Id: "ParamHair" } }] }],
    }),
  );
  await writeFile(
    join(runtime, "motion", "source.motion3.json"),
    JSON.stringify({
      Curves: [
        { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 1, 10] },
      ],
    }),
  );
  await writeFile(
    join(runtime, "motion", "generated.motion3.json"),
    JSON.stringify({
      Curves: [
        { Target: "Parameter", Id: "ParamAngleX", Segments: [0, -999, 0, 1, 999] },
      ],
    }),
  );

  const analysis = await analyzeModel(root);
  assert.equal(analysis.motionCount, 1);
  assert.deepEqual(analysis.parameters, [
    {
      id: "ParamAngleX",
      name: "Head X",
      minimum: 0,
      maximum: 10,
      base: 0,
      physicsOutput: false,
    },
    {
      id: "ParamHair",
      name: "Hair",
      minimum: null,
      maximum: null,
      base: null,
      physicsOutput: true,
    },
  ]);
  const rendered = formatModelAnalysis(analysis);
  assert.match(rendered, /ParamAngleX/);
  assert.match(rendered, /0\.00\s+10\.00\s+0\.00/);
  assert.match(rendered, /ParamHair.*★phys/);
  assert.doesNotMatch(rendered, /999\.00/);
});
