// scripts/fix-migrations.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'src', 'db', 'migrations');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '_archived') continue;
      out.push(...walk(p));
    } else if (e.isFile() && e.name.endsWith('.sql') && !e.name.endsWith('.ignore')) {
      out.push(p);
    }
  }
  return out;
}

const isBaseline = (fname) => /^(000_|001_|002_)/.test(fname);

function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeTerminators(sql) {
  // Corrige apenas DO terminators: END $$; -> END; $$;
  return sql.replace(/END\s*\$\$;/g, 'END; $$;');
}

(function main() {
  const files = walk(MIG_DIR);
  let changed = 0;

  for (const file of files) {
    const fname = path.basename(file);
    // NUNCA tocar em baseline
    if (isBaseline(fname)) continue;

    let s = fs.readFileSync(file, 'utf8');
    const orig = s;
    s = normalizeEol(s);
    s = normalizeTerminators(s);

    if (s !== orig) {
      fs.writeFileSync(file, s, 'utf8');
      changed++;
      console.log(`[fix] ${path.relative(ROOT, file)} UPDATED`);
    }
  }

  console.log(`[done] Corrigidos terminadores em ${changed} arquivo(s) fora do baseline (000/001/002).`);
})();
