const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const DEST = path.join(ROOT, 'dist', 'public');

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    return false;
  }

  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }

  return true;
}

function copyPublic() {
  ensureDir(DEST);
  const copied = copyDir(SRC, DEST);
  if (copied) {
    console.log('[copyPublic] public/ copiado para dist/public');
  } else {
    console.log('[copyPublic] Nenhuma pasta public/ encontrada para copiar.');
  }
}

module.exports = { copyPublic };

if (require.main === module) {
  try {
    copyPublic();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
