import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    files: ["tests-node/**/*.ts"],
    rules: {
      // Model-security fixtures intentionally probe malformed untyped JSON.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "models/**",
    "local-assets/**",
    "motion-defs/generated/**",
    "tmp-verify/**",
    "artifacts/**",
    // The proven legacy Live2D runtime is syntax-checked separately because it
    // intentionally uses a DOM-oriented module/IIFE style outside React.
    "assets/app.js",
  ]),
]);
