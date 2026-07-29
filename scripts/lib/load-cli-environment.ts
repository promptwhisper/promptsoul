import { loadEnvConfig } from "@next/env";

/**
 * Load the same dotenv files and precedence that Next.js uses for the current
 * mode. Values explicitly exported by the invoking shell remain authoritative.
 */
export function loadCliEnvironment(directory = process.cwd()): void {
  loadEnvConfig(directory, process.env.NODE_ENV !== "production");
}
