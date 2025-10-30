const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDbDir = path.join(rootDir, 'dist', 'db');
const migrationsSrcDir = path.join(rootDir, 'src', 'db', 'migrations');
const migrationsDestDir = path.join(distDbDir, 'migrations');
const sqlSrcDir = path.join(rootDir, 'src', 'db', 'sql');
const sqlDestDir = path.join(distDbDir, 'sql');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function cleanDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } else {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    return false;
  }

  ensureDir(destDir);
  cleanDir(destDir);

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }

  return true;
}

function main() {
  ensureDir(migrationsDestDir);
  ensureDir(sqlDestDir);

  console.log('copiando migrations...');
  const migrationsCopied = copyDir(migrationsSrcDir, migrationsDestDir);
  if (!migrationsCopied) {
    cleanDir(migrationsDestDir);
  }

  console.log('copiando sql...');
  const sqlCopied = copyDir(sqlSrcDir, sqlDestDir);
  if (!sqlCopied) {
    cleanDir(sqlDestDir);
  }

  console.log('feito.');
}

try {
  ensureDir(distDbDir);
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
