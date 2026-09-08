// Copies the prebuilt tree-sitter-rust grammar wasm from the tree-sitter-wasms
// dependency into this package's assets/ dir so the published package is
// self-contained (survives dep pruning/dedupe). Plain JS: runs before the TS
// build output is required. Cross-platform (uses path.join, no separators).
const fs = require('fs');
const path = require('path');

function main() {
  const pkgRoot = path.join(__dirname, '..');
  const assetsDir = path.join(pkgRoot, 'assets');
  const dest = path.join(assetsDir, 'tree-sitter-rust.wasm');

  let src;
  try {
    const wasmsPkg = require.resolve('tree-sitter-wasms/package.json');
    src = path.join(path.dirname(wasmsPkg), 'out', 'tree-sitter-rust.wasm');
  } catch (e) {
    console.error('[copy-wasm] could not resolve tree-sitter-wasms:', e.message);
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error('[copy-wasm] grammar wasm not found at', src);
    process.exit(1);
  }
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(src, dest);
  const bytes = fs.statSync(dest).size;
  console.log(`[copy-wasm] bundled tree-sitter-rust.wasm (${bytes} bytes) -> assets/`);
}

main();
