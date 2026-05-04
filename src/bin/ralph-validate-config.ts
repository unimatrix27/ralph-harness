#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  ValidateError,
  moduleErr,
  validate,
} from "../lib/target-config-schema.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write(
    moduleErr("usage: ralph-validate-config <path-to-config.yaml>") + "\n",
  );
  process.exit(2);
}

const path = args[0]!;

let yamlString: string;
try {
  yamlString = readFileSync(path, "utf8");
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    process.stderr.write(moduleErr(`config file not found: ${path}`) + "\n");
    process.exit(2);
  }
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(moduleErr(`could not read ${path}: ${detail}`) + "\n");
  process.exit(2);
}

try {
  validate(yamlString);
} catch (err) {
  if (err instanceof ValidateError) {
    const msg =
      err.code === 3
        ? err.message.replace(
            /^malformed yaml/,
            `malformed yaml in ${path}`,
          )
        : err.message;
    process.stderr.write(moduleErr(msg) + "\n");
    process.exit(err.code);
  }
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(moduleErr(`unexpected error: ${detail}`) + "\n");
  process.exit(6);
}

process.stdout.write(`ok: ${path} is a valid .ralph/config.yaml\n`);
process.exit(0);
