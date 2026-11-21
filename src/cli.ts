#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-app.js";

export { runCli } from "./cli-app.js";

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const normalize = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  try {
    const resolvedEntry = fs.realpathSync.native(path.resolve(entry));
    const resolvedSelf = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return normalize(resolvedEntry) === normalize(resolvedSelf);
  } catch {
    return normalize(path.resolve(entry)) === normalize(fileURLToPath(import.meta.url));
  }
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
