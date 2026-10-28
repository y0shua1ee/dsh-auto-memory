#!/usr/bin/env node
/**
 * Extract the packaged DSH runtime from `app.asar` for tests and local
 * inspection.
 *
 * The Electron archive on this build is a Chromium pickle with a 16-byte
 * prefix before the JSON header; the usual `@electron/asar` reader does not
 * apply. Native modules live in the sibling `app.asar.unpacked/dsh` tree and
 * are copied over the extracted files.
 *
 * Usage:
 *   node scripts/extract-runtime.mjs [app.asar] [destination]
 *
 * Defaults:
 *   /Applications/DeepSeek Harness.app/Contents/Resources/app.asar
 *   /tmp/dsh-app
 */
import fs from "node:fs";
import path from "node:path";

const asar =
  process.argv[2] ??
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const destination = path.resolve(process.argv[3] ?? "/tmp/dsh-app");
const unpacked = `${asar}.unpacked`;

if (!fs.existsSync(asar)) {
  console.error(`app.asar not found: ${asar}`);
  process.exit(1);
}

const handle = fs.openSync(asar, "r");
try {
  const prefix = Buffer.alloc(16);
  fs.readSync(handle, prefix, 0, 16, 0);
  const headerBytes = prefix.readUInt32LE(12);
  const dataBase = 8 + prefix.readUInt32LE(4);
  const headerBuffer = Buffer.alloc(headerBytes);
  fs.readSync(handle, headerBuffer, 0, headerBytes, 16);
  const header = JSON.parse(headerBuffer.toString("utf8"));

  const files = [];
  const walk = (node, parent) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relative = parent === "" ? name : `${parent}/${name}`;
      if (entry.files) walk(entry, relative);
      else if (!entry.unpacked) {
        files.push({ path: relative, offset: Number(entry.offset), size: entry.size });
      }
    }
  };
  walk(header, "");

  let extracted = 0;
  for (const file of files) {
    if (!file.path.startsWith("dsh/")) continue;
    const target = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = Buffer.alloc(file.size);
    fs.readSync(handle, content, 0, file.size, dataBase + file.offset);
    fs.writeFileSync(target, content);
    extracted += 1;
  }

  if (fs.existsSync(path.join(unpacked, "dsh"))) {
    fs.cpSync(path.join(unpacked, "dsh"), path.join(destination, "dsh"), {
      recursive: true,
      force: true
    });
  }

  const modules = path.join(destination, "dsh", "node_modules");
  console.log(`extracted ${extracted} files to ${destination}`);
  console.log(`DSH_APP_NODE_MODULES=${modules}`);
} finally {
  fs.closeSync(handle);
}
