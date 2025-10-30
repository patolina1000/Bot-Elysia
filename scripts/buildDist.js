const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const { cleanDist } = require('./cleanDist');
const { copySql } = require('./copySql');
const { copyPublic } = require('./copyPublic');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function ensureDistExists() {
  if (!fs.existsSync(DIST)) {
    fs.mkdirSync(DIST, { recursive: true });
  }
}

function runTypeScriptBuild() {
  const tscPath = require.resolve('typescript/lib/tsc.js');
  const tsconfigPath = path.join(ROOT, 'tsconfig.json');
  console.log('[buildDist] Executando TypeScript...');
  execFileSync(process.execPath, [tscPath, '-p', tsconfigPath], {
    stdio: 'inherit',
  });
}

function buildDist() {
  cleanDist();
  ensureDistExists();
  runTypeScriptBuild();
  copySql();
  copyPublic();
  console.log('[buildDist] Build finalizado.');
}

module.exports = { buildDist };

if (require.main === module) {
  try {
    buildDist();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
