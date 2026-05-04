#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

process.stderr.write(
  `ralph-fire: only --version is implemented in this slice (v${pkg.version}); ` +
    `the real launcher lands in slice 5\n`,
);
process.exit(64);
