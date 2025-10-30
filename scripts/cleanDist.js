const fs = require('fs');
const path = require('path');

const DIST = path.join(process.cwd(), 'dist');

function cleanDist() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST, { recursive: true });
  console.log('[cleanDist] dist recriado');
}

module.exports = { cleanDist };

if (require.main === module) {
  try {
    cleanDist();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
