import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

test("CLI loads Next dotenv files while preserving explicit shell values", async () => {
  const projectRoot = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "promptsoul-aivis-cli-env-"));
  try {
    await writeFile(path.join(directory, ".env.local"), [
      "AIVIS_BASE_URL=http://127.0.0.1:14567",
      "AIVIS_STYLE_NAME=file-style",
      "",
    ].join("\n"));
    const helper = pathToFileURL(
      path.join(projectRoot, "scripts/lib/load-cli-environment.ts"),
    ).href;
    const probe = path.join(directory, "probe.ts");
    await writeFile(probe, [
      `import { loadCliEnvironment } from ${JSON.stringify(helper)};`,
      "loadCliEnvironment();",
      "console.log(JSON.stringify({",
      "  baseUrl: process.env.AIVIS_BASE_URL,",
      "  styleName: process.env.AIVIS_STYLE_NAME,",
      "}));",
      "",
    ].join("\n"));

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      AIVIS_STYLE_NAME: "shell-style",
    };
    delete environment["AIVIS_BASE_URL"];
    delete environment["__NEXT_PROCESSED_ENV"];
    const result = spawnSync(
      path.join(projectRoot, "node_modules/.bin/tsx"),
      [probe],
      { cwd: directory, env: environment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      baseUrl: "http://127.0.0.1:14567",
      styleName: "shell-style",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
