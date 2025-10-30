const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DB_DIR = path.join(ROOT, 'dist', 'db');
const MIGRATIONS_SRC = path.join(ROOT, 'src', 'db', 'migrations');
const MIGRATIONS_DEST = path.join(DIST_DB_DIR, 'migrations');
const SQL_SRC = path.join(ROOT, 'src', 'db', 'sql');
const SQL_DEST = path.join(DIST_DB_DIR, 'sql');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resetDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    return false;
  }

  ensureDir(destDir);

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }

  return true;
}

function copySql() {
  ensureDir(DIST_DB_DIR);

  resetDir(MIGRATIONS_DEST);
  resetDir(SQL_DEST);

  console.log('[copySql] Copiando migrations...');
  const migrationsCopied = copyDirContents(MIGRATIONS_SRC, MIGRATIONS_DEST);
  if (!migrationsCopied) {
    console.warn('[copySql] Nenhuma migration encontrada.');
  }

  console.log('[copySql] Copiando SQL adicional...');
  const sqlCopied = copyDirContents(SQL_SRC, SQL_DEST);
  if (!sqlCopied) {
    console.warn('[copySql] Nenhum arquivo SQL adicional encontrado.');
  }

  console.log('[copySql] Concluído.');
}

module.exports = { copySql };

if (require.main === module) {
  try {
    copySql();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
