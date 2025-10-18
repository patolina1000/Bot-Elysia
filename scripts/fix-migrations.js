// scripts/fix-migrations.js
// Node >= 16

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'src', 'db', 'migrations');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      // não precisamos mexer no _archived
      if (name.name === '_archived') continue;
      out.push(...walk(p));
    } else if (name.isFile() && name.name.endsWith('.sql')) {
      // ignora .ignore
      if (name.name.endsWith('.ignore')) continue;
      out.push(p);
    }
  }
  return out;
}

function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeTerminators(sql) {
  // corrige TODOS os casos "END $$;" para "END; $$;"
  return sql
    .replace(/END\s*\$\$;/g, () => 'END; $$;')
    .replace(/END;\s*\$;/g, () => 'END; $$;');
}

function removeDoBlockCreatingFn(sql) {
  // remove o DO $$ ... END; $$; que cria a fn_touch_updated_at dinamicamente
  // padrão: DO $$ ... proname = 'fn_touch_updated_at' ... END; $$;
  const re = /--\s*\[MIG\]\[SHOTS_QUEUE\]\s*Create or update the touch trigger function\.[\s\S]*?(?=\n--\s*\[MIG\]\[SHOTS_QUEUE\]\s*Attach)/i;
  return sql.replace(re, '\n');
}

function ensureFnTouchUpdatedAt(sql) {
  // injeta a função se não existir como CREATE OR REPLACE "puro" (fora de DO)
  const hasFn = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_touch_updated_at\s*\(\)/i.test(sql);
  if (hasFn) return sql;

  const fnDef = `
-- [MIG][SHOTS_QUEUE] Ensure fn_touch_updated_at trigger helper exists.
CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $BODY$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$BODY$;
`.trim();

  // preferimos inserir a função antes da seção de triggers da shots_queue, se houver
  const marker = /--\s*\[MIG\]\[SHOTS_QUEUE\].*attach.*updated_at.*trigger/i;
  const m = sql.match(marker);
  if (m) {
    const idx = m.index;
    return sql.slice(0, idx) + '\n' + fnDef + '\n\n' + sql.slice(idx);
  }
  // fallback: apenda no final
  return sql + '\n\n' + fnDef + '\n';
}

function fixShotsQueuePerRecipient(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  const orig = src;

  src = normalizeEol(src);
  src = normalizeTerminators(src);

  // remove o DO que cria a fn dynamicamente e injeta a função pura fora de DO
  src = removeDoBlockCreatingFn(src);
  src = ensureFnTouchUpdatedAt(src);
  src = src.replace(/\n{3,}/g, '\n\n');

  if (src !== orig) {
    fs.writeFileSync(filePath, src, 'utf8');
    return true;
  }
  return false;
}

function bulkFixTerminators(files) {
  let changed = 0;
  for (const f of files) {
    let s = fs.readFileSync(f, 'utf8');
    const orig = s;
    s = normalizeEol(s);
    s = normalizeTerminators(s);
    if (s !== orig) {
      fs.writeFileSync(f, s, 'utf8');
      changed++;
    }
  }
  return changed;
}

(function main() {
  const files = walk(MIG_DIR);

  // 1) Corrigir especificamente a shots_queue_per_recipient
  const target = files.find(p => path.basename(p) === '20251018_shots_queue_per_recipient.sql');
  let fixedTarget = false;
  if (target) {
    fixedTarget = fixShotsQueuePerRecipient(target);
    console.log(`[fix] ${path.relative(ROOT, target)} ${fixedTarget ? 'UPDATED' : 'OK'}`);
  } else {
    console.warn('[warn] 20251018_shots_queue_per_recipient.sql não encontrado.');
  }

  // 2) Varrer todas as migrações e corrigir terminadores
  const changed = bulkFixTerminators(files);
  console.log(`[scan] Terminadores corrigidos em ${changed} arquivo(s).`);

  // 3) Resumo
  console.log('[done] Migrações revisadas.');
})();

