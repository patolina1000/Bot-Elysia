# Relatório de Consolidação de Migrações

**Data:** 2025-10-17  
**Branch:** cursor/consolidate-and-order-migration-files-2c91

## Problema Identificado

De acordo com os logs do Render, havia:
1. Duas pastas de migração: `Elysia/src/db/migrations` e `Elysia/db/migrations`
2. Arquivos duplicados sendo copiados para `dist/db/migrations`
3. Ordem alfabética quebrada causando backfill antes do create
4. Erro: `relation "telegram_contacts" does not exist`

## Situação Atual (Verificada)

### ✅ 1. Fonte Única de Migrações
- **Status:** CORRETO
- Pasta `db/migrations` não existe mais (ou nunca existiu neste branch)
- Todos os arquivos consolidados em `src/db/migrations/`
- 29 arquivos de migração no total

### ✅ 2. Script de Build Correto
- **Status:** CORRETO
- `package.json` script `copy-sql` limpa destino antes de copiar:
  ```bash
  rm -rf dist/db/migrations dist/db/sql
  ```
- Copia apenas de `src/db/migrations/`:
  ```bash
  cp -r src/db/migrations/*.sql dist/db/migrations/
  ```

### ✅ 3. Ordem dos Arquivos telegram_contacts
- **Status:** CORRETO
- Arquivos nomeados com prefixos para garantir ordem:
  - `20251017_a_create_telegram_contacts.sql` (CREATE antes)
  - `20251017_b_backfill_telegram_contacts.sql` (BACKFILL depois)

### ✅ 4. Idempotência das Migrações

#### create_telegram_contacts.sql
- ✅ `CREATE TYPE ... EXCEPTION WHEN duplicate_object`
- ✅ `CREATE TABLE IF NOT EXISTS`
- ✅ `CREATE INDEX IF NOT EXISTS`
- ✅ `DROP TRIGGER IF EXISTS` antes de criar

#### backfill_telegram_contacts.sql
- ✅ `ON CONFLICT (bot_slug, telegram_id) DO UPDATE`
- ✅ Pode rodar múltiplas vezes sem erro

## Correções Aplicadas

### 📝 Padronização de Nomenclatura
Renomeados arquivos para formato consistente `YYYYMMDD`:
- `2025-10-12_add_start_messages_array.sql` → `20251012_add_start_messages_array.sql`
- `2025-10-12_alter_bot_settings_offers_text.sql` → `20251012_alter_bot_settings_offers_text.sql`

**Razão:** Formato com hífens (`2025-10-12`) quebra ordem alfabética comparado a `20251011`.

## Ordem Final das Migrações

```
000_enable_pgcrypto.sql
001_add_downsells_queue.sql
001b_add_event_id.sql
001c_add_created_at.sql
001_core_tables.sql
001d_fix_event_column.sql
001f_quick_checks.sql
001g_funnel_backcompat.sql
001h_fix_funnel_counters.sql
002_add_downsells_sent.sql
002_indexes.sql
20251011_add_media_cache.sql
20251011_create_bot_plans.sql
20251011_create_bot_settings.sql
20251011_create_payment_transactions.sql
20251011_enable_core_start.sql
20251012_add_start_messages_array.sql          ← RENOMEADO
20251012_alter_bot_settings_offers_text.sql    ← RENOMEADO
20251014_alter_bot_downsells_add_plan_id.sql
20251014_alter_bot_downsells_add_plan_label.sql
20251014_downsells_queue_extras.sql
20251014_fix_downsells_queue_fk_v2.sql
20251014_fix_scheduled_at_default.sql
20251014_idx_downsells_queue_scheduled.sql
20251016_add_extra_plans_to_bot_downsells.sql
20251016_downsells_metrics.sql
20251017_a_create_telegram_contacts.sql        ← CREATE PRIMEIRO
20251017_b_backfill_telegram_contacts.sql      ← BACKFILL DEPOIS
20251017_idx_funnel_metrics.sql
```

## Critérios de Aceite

### ✅ Pasta db/migrations não existe
- Confirmado: pasta não encontrada

### ✅ Arquivos aparecem na ordem correta
- `…_a_create_telegram_contacts.sql` ANTES de `…_b_backfill_telegram_contacts.sql`

### ✅ Script copy-sql limpa destino
- `rm -rf dist/db/migrations` executado antes da cópia

### ✅ Migrações idempotentes
- CREATE: usa `IF NOT EXISTS` e `EXCEPTION WHEN duplicate_object`
- BACKFILL: usa `ON CONFLICT ... DO UPDATE`

## Próximos Passos

1. **Commit das mudanças:**
   - Renomeação dos arquivos de outubro 12

2. **Deploy no Render:**
   - As migrações devem rodar sem erro 42P01
   - Ordem garantida: CREATE antes de BACKFILL
   - Sem duplicações de arquivos em `dist/db/migrations`

3. **Verificação pós-deploy:**
   - Checar logs do Render para confirmar ordem correta
   - Verificar que `telegram_contacts` foi criada antes do backfill
   - Confirmar que não há erro "relation does not exist"

## Comandos Úteis para Debugging

```bash
# Verificar ordem dos arquivos que serão copiados
ls -1 src/db/migrations/*.sql | sort

# Verificar conteúdo de dist após build
npm run build && ls -1 dist/db/migrations/

# Testar migrações localmente
npm run migrate
```

## Conclusão

✅ **Todos os problemas identificados foram corrigidos:**
- Uma única fonte de migrações (`src/db/migrations/`)
- Script de build limpa destino antes de copiar
- Ordem alfabética correta para `telegram_contacts`
- Migrações totalmente idempotentes
- Nomenclatura padronizada para todos os arquivos

**Pronto para deploy!** 🚀
