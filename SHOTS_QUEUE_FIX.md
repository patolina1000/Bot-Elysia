# Fix: Erro "column media_url does not exist" - shots_queue

## 🔴 Problema Identificado

O sistema estava gerando o seguinte erro em produção:

```
error: column "media_url" of relation "shots_queue" does not exist
at createShot (/opt/render/project/src/dist/db/shotsQueue.js:35:20)
at /opt/render/project/src/dist/admin/shots.js:73:26
```

### Análise da Causa

O código TypeScript em `shotsQueue.ts` (linha 68-74) tenta inserir dados na coluna `media_url`:

```typescript
INSERT INTO shots_queue (
  bot_slug, target, copy, media_url, media_type, scheduled_at,
  status, attempt_count
)
VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), 'pending', 0)
```

Porém, **no banco de dados de produção**, a tabela `shots_queue` foi criada **sem a coluna `media_url`**.

### Por que isso aconteceu?

1. A migração inicial `20251017_create_shots_queue.sql` define a tabela com `media_url`
2. Mas existem migrações subsequentes (`20251018_fix_shots_queue_copy_and_attempts.sql`) que tentam recriar colunas com tipos diferentes
3. Isso sugere que houve execução parcial ou desordena de migrações em produção
4. A tabela pode ter sido criada antes de todas as migrações serem finalizadas

## ✅ Solução Implementada

Criei a migração **`20251019_fix_shots_queue_media_columns.sql`** que:

### 1. Garante que os ENUMs existem
```sql
CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
CREATE TYPE shot_status_enum AS ENUM ('pending', 'running', 'sent', 'skipped', 'error');
```

### 2. Adiciona TODAS as colunas necessárias de forma idempotente

A migração verifica e adiciona cada coluna apenas se ela não existir:

- ✅ `media_url` (TEXT)
- ✅ `media_type` (TEXT com CHECK constraint)
- ✅ `bot_slug` (TEXT NOT NULL)
- ✅ `copy` (TEXT NOT NULL)
- ✅ `scheduled_at` (TIMESTAMPTZ NOT NULL)
- ✅ `created_at` (TIMESTAMPTZ NOT NULL)
- ✅ `updated_at` (TIMESTAMPTZ NOT NULL)

### 3. Aplica Constraints Corretas

```sql
ALTER TABLE shots_queue
  ADD CONSTRAINT shots_queue_media_type_check
  CHECK (media_type IN ('photo', 'video', 'audio', 'none'));
```

## 🚀 Como Aplicar

A migração será aplicada automaticamente no próximo deploy, pois:

1. O sistema de migrações (`runMigrations.ts`) executa automaticamente ao iniciar
2. A migração está nomeada com data `20251019` (posterior às existentes)
3. Ela é **idempotente** - pode ser executada múltiplas vezes sem causar erros

## 📋 Verificação Pós-Deploy

Após o deploy, verifique se a migração foi aplicada:

```sql
-- 1. Verificar se a migração foi registrada
SELECT * FROM _schema_migrations 
WHERE filename = '20251019_fix_shots_queue_media_columns.sql';

-- 2. Verificar se a coluna media_url existe
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'shots_queue'
  AND column_name = 'media_url';

-- 3. Verificar todas as colunas da tabela
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'shots_queue'
ORDER BY ordinal_position;
```

## 🧪 Teste Funcional

Após o deploy, teste a criação de um shot:

```bash
curl -X POST https://bot-elysia.onrender.com/admin/api/shots \
  -H "Authorization: Bearer admin_87112524aA@" \
  -H "Content-Type: application/json" \
  -d '{
    "bot_slug": "hadrielle-maria",
    "target": "started",
    "copy": "Teste de disparo",
    "media_url": "https://exemplo.com/imagem.jpg",
    "media_type": "photo"
  }'
```

**Resultado esperado:** Status 201 com o objeto `shot` criado.

## 📝 Estrutura Final Esperada

Após a migração, a tabela `shots_queue` deve ter:

```sql
CREATE TABLE shots_queue (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  target shot_target_enum NOT NULL,
  copy TEXT NOT NULL,
  media_url TEXT,                    -- ← COLUNA ADICIONADA
  media_type TEXT,                   -- ← COLUNA ADICIONADA
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status shot_status_enum NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 🔍 Arquivos Modificados

- ✅ `src/db/migrations/20251019_fix_shots_queue_media_columns.sql` (NOVO)

## 📚 Arquivos Analisados

- `src/db/migrations/20251017_create_shots_queue.sql` - Migração original
- `src/db/migrations/20251018_fix_shots_queue_copy_and_attempts.sql` - Fix anterior
- `src/db/migrations/20251018_fix_shots_queue_target.sql` - Fix do enum
- `src/db/shotsQueue.ts` - Código que usa media_url
- `src/admin/shots.ts` - Endpoint que cria shots
- `src/db/runMigrations.ts` - Sistema de migrações

## 🎯 Conclusão

O erro será resolvido assim que o deploy for feito e a nova migração for aplicada automaticamente. A migração é segura e idempotente, não causará problemas mesmo se executada múltiplas vezes.

