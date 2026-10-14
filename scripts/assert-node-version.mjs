#!/usr/bin/env node

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (!Number.isFinite(major) || major !== 26) {
  console.error(`[ci] Node.js 26.x is required, current=${process.versions.node}`);
  process.exit(1);
}

console.log(`[ci] Node.js version OK: ${process.versions.node}`);
