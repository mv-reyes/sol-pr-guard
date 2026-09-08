#!/usr/bin/env node
// Portable test launcher: enumerates dist/test recursively and passes an
// explicit file list to `node --test`, so the suite runs identically on
// Node 18/20/22 and on every OS (no glob support assumptions).
"use strict";
const { readdirSync, statSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

const files = walk(join(__dirname, "..", "dist", "test")).sort();
if (!files.length) {
  console.error("no test files found under dist/test (run the build first)");
  process.exit(1);
}
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status == null ? 1 : res.status);
