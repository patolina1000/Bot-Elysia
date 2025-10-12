# Fix: delay_minutes Field Handling - Summary

## ✅ Status: TODOS OS COMPONENTES JÁ ESTÃO CORRETOS

Após análise completa do código, **todas as correções necessárias já estão implementadas**. O sistema está configurado corretamente para:

1. ✅ Validar `delay_minutes` entre 5 e 60
2. ✅ Aceitar tanto snake_case quanto camelCase no backend
3. ✅ Enviar `delay_minutes` em snake_case do frontend
4. ✅ Armazenar na coluna correta do banco de dados
5. ✅ Incluir tabela de métricas (`downsell_metrics`)

---

## 🔍 Problemas Originais Reportados

### Problema 1: `422 invalid_delay`
**Descrição**: Backend validando delay_minutes e exigindo inteiro entre 5 e 60.

**Resolução**: ✅ Código já implementado corretamente
- Backend valida o campo (linhas 332-334 em `src/admin/bots.ts`)
- Frontend tem validação HTML (min=5, max=60 em `admin-wizard.html`)

### Problema 2: `500 downsells_upsert_failed + Postgres 42703`
**Descrição**: Após validação passar, upsert tenta gravar coluna que não existe.

**Resolução**: ✅ Migration já define a coluna
- Coluna `delay_minutes` definida em `20251012_downsells.sql` (linha 6)
- Com constraint CHECK correta: `BETWEEN 5 AND 60`

---

## 📋 Verificação do Código Existente

### 1. Frontend: `public/admin-wizard.html`

**✅ JÁ ENVIA em snake_case:**
```javascript
// Linha 3334
const body = {
  bot_slug: slug,
  trigger_kind: dsTrigger.value,
  delay_minutes: toInt(dsDelay.value, 10), // ← SNAKE_CASE ✅
  title: dsTitle.value.trim(),
  price_cents: toCents(dsPrice.value),
  // ...
};
```

**✅ Validação HTML:**
```html
<!-- Linha 1375 -->
<input id="ds-delay" type="number" min="5" max="60" value="10" />
```

---

### 2. Backend: `src/admin/bots.ts`

**✅ ACEITA ambos os formatos (snake_case e camelCase):**
```typescript
// Linhas 304-323
const normalized = {
  delay_minutes: +(b.delay_minutes ?? b.delayMinutes ?? 10), // ← FLEXÍVEL ✅
  // ...
};

// Linhas 332-334: Validação
if (!Number.isFinite(normalized.delay_minutes) || 
    normalized.delay_minutes < 5 || 
    normalized.delay_minutes > 60) {
  return res.status(422).json({ 
    ok: false, 
    error: 'invalid_delay', 
    details: 'delay_minutes deve ser entre 5 e 60' 
  });
}
```

---

### 3. Database: `src/db/migrations/20251012_downsells.sql`

**✅ Coluna definida com constraint:**
```sql
-- Linha 6
CREATE TABLE IF NOT EXISTS downsells (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('after_start','after_pix')),
  delay_minutes INT NOT NULL CHECK (delay_minutes BETWEEN 5 AND 60), -- ← AQUI ✅
  title TEXT NOT NULL,
  price_cents INT NOT NULL CHECK (price_cents >= 50),
  -- ...
);
```

---

### 4. Database Layer: `src/db/downsells.ts`

**✅ Função upsertDownsell usa snake_case:**
```typescript
// Linhas 92-166
export async function upsertDownsell(input: UpsertDownsellInput): Promise<Downsell> {
  if (input.id) {
    // UPDATE
    const res = await pool.query(
      `UPDATE downsells
         SET trigger_kind = $1,
             delay_minutes = $2, -- ← SNAKE_CASE ✅
             title = $3,
             // ...
       WHERE id = $17 AND bot_slug = $18`,
      [input.trigger_kind, input.delay_minutes, input.title, ...]
    );
  } else {
    // INSERT
    const res = await pool.query(
      `INSERT INTO downsells
        (bot_slug, trigger_kind, delay_minutes, ...) -- ← SNAKE_CASE ✅
       VALUES ($1,$2,$3,...)`,
      [input.bot_slug, input.trigger_kind, input.delay_minutes, ...]
    );
  }
}
```

---

### 5. Métricas: `src/db/migrations/20251012_downsells_metrics.sql`

**✅ Tabela de métricas definida:**
```sql
CREATE TABLE IF NOT EXISTS downsell_metrics (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  downsell_id BIGINT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('view', 'click', 'purchase', 'pix_created')),
  telegram_id BIGINT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_dm_bot_slug ON downsell_metrics(bot_slug);
CREATE INDEX IF NOT EXISTS idx_dm_downsell_id ON downsell_metrics(downsell_id);
CREATE INDEX IF NOT EXISTS idx_dm_event ON downsell_metrics(event);
-- ...
```

---

## 🚀 Próximos Passos (Apenas Executar Migrations)

### Passo 1: Configurar Ambiente

Se ainda não configurou o `.env`:

```bash
cp .env.example .env
# Edite .env e configure DATABASE_URL
```

### Passo 2: Executar Migrations

```bash
npm run migrate
```

Ou diretamente:

```bash
npx tsx src/db/runMigrations.ts
```

### Passo 3: Verificar Schema

```bash
npm run verify:downsells
```

Ou diretamente:

```bash
npx tsx scripts/verify-downsells-schema.ts
```

---

## 🔬 Verificação Manual (Opcional)

Se preferir verificar manualmente no PostgreSQL:

```sql
-- 1. Verificar se a coluna delay_minutes existe
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns 
WHERE table_name = 'downsells' 
  AND column_name = 'delay_minutes';
-- Esperado: delay_minutes | integer | NO | (null)

-- 2. Verificar constraint
SELECT conname, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'downsells'::regclass 
  AND conname LIKE '%delay%';
-- Esperado: CHECK ((delay_minutes >= 5) AND (delay_minutes <= 60))

-- 3. Verificar tabela de métricas
SELECT table_name 
FROM information_schema.tables 
WHERE table_name = 'downsell_metrics';
-- Esperado: downsell_metrics

-- 4. Verificar índices
SELECT indexname 
FROM pg_indexes 
WHERE tablename IN ('downsells', 'downsell_metrics')
ORDER BY indexname;
```

---

## 📊 Ordem das Migrations

As migrations estão ordenadas corretamente:

```
000_enable_pgcrypto.sql
001_core_tables.sql
001b_add_event_id.sql
001c_add_created_at.sql
001d_fix_event_column.sql
001f_quick_checks.sql
001g_funnel_backcompat.sql
001h_fix_funnel_counters.sql
002_indexes.sql
20251011_add_media_cache.sql
20251011_create_bot_plans.sql
20251011_create_bot_settings.sql
20251011_create_payment_transactions.sql
20251011_enable_core_start.sql
2025-10-12_add_start_messages_array.sql
2025-10-12_alter_bot_settings_offers_text.sql
20251012_downsells.sql           ← Define tabela downsells
20251012_downsells_metrics.sql   ← Define tabela de métricas
```

---

## ✅ Resumo Final

| Componente | Status | Localização |
|------------|--------|-------------|
| Frontend (HTML/JS) | ✅ Correto | `public/admin-wizard.html` linhas 1375, 3334 |
| Backend (Validação) | ✅ Correto | `src/admin/bots.ts` linhas 308, 332-334 |
| Backend (Normalização) | ✅ Correto | `src/admin/bots.ts` linha 308 (aceita ambos) |
| Database (Migration) | ✅ Correto | `src/db/migrations/20251012_downsells.sql` linha 6 |
| Database (Código TS) | ✅ Correto | `src/db/downsells.ts` linhas 98, 139 |
| Tabela de Métricas | ✅ Correto | `src/db/migrations/20251012_downsells_metrics.sql` |
| Script de Verificação | ✅ Disponível | `scripts/verify-downsells-schema.ts` linha 87 |

---

## 🎯 Conclusão

**NENHUMA ALTERAÇÃO DE CÓDIGO É NECESSÁRIA.** 

Todos os componentes já estão implementados corretamente:
- ✅ Frontend envia `delay_minutes` em snake_case
- ✅ Backend aceita ambos formatos e valida 5-60
- ✅ Migration define coluna com constraint correto
- ✅ Código TypeScript usa snake_case consistentemente
- ✅ Tabela de métricas está definida

**Ação Necessária**: Apenas executar `npm run migrate` no ambiente de produção/staging para aplicar as migrations.

---

## 📌 Branch Atual

```
cursor/fix-delay-minutes-field-handling-a886
```

---

## 📝 Exemplo de Payload Correto

O frontend já envia este formato:

```json
{
  "bot_slug": "meu-bot",
  "trigger_kind": "after_start",
  "delay_minutes": 15,
  "title": "Oferta Especial",
  "price_cents": 990,
  "message_text": "Obrigada pela compra! 💖",
  "media1_url": "https://example.com/image.jpg",
  "media1_type": "photo",
  "is_active": true
}
```

Todos os campos estão em snake_case e `delay_minutes` está entre 5 e 60. ✅
