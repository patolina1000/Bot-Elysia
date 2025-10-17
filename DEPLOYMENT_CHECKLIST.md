# 🚀 Checklist de Deploy - Sistema de Telegram Contacts

## ✅ Pré-Deploy (Desenvolvimento)

- [x] Código implementado e revisado
- [x] TypeScript compilado sem erros
- [x] Sem erros de lint
- [x] Migrations SQL criadas
- [x] Documentação completa

## 📋 Checklist de Deploy

### 1. Backup do Banco de Dados
```bash
# Fazer backup antes de aplicar migrations
pg_dump $DATABASE_URL > backup_pre_telegram_contacts_$(date +%Y%m%d).sql
```

### 2. Verificar Migrations Pendentes
```bash
# Listar migrations no diretório
ls -la src/db/migrations/ | grep 20251017

# Devem existir:
# - 20251017_create_telegram_contacts.sql
# - 20251017_backfill_telegram_contacts.sql
```

### 3. Deploy do Código
```bash
# Pull do código
git pull origin cursor/gerenciar-contatos-e-estados-do-telegram-b7bf

# Instalar dependências
npm install

# Build
npm run build

# Verificar build
ls -la dist/services/TelegramContactsService.js
ls -la dist/utils/telegramErrorHandler.js
ls -la dist/telegram/features/chatMember/
```

### 4. Aplicar Migrations
```bash
# Opção 1: Automático ao iniciar app
npm start

# Opção 2: Manual
node dist/db/runMigrations.js
```

### 5. Verificar Migrations Aplicadas
```sql
-- Conectar ao banco
psql $DATABASE_URL

-- Verificar tabela criada
\d telegram_contacts

-- Verificar enum
SELECT enumlabel FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'chat_state_enum';

-- Verificar índices
\di telegram_contacts*

-- Verificar dados backfilled
SELECT COUNT(*) FROM telegram_contacts;
SELECT chat_state, COUNT(*) FROM telegram_contacts GROUP BY chat_state;
```

### 6. Testar Endpoint de Métricas
```bash
# Substituir PORT e TOKEN pelos seus valores
curl -X GET "http://localhost:PORT/admin/metrics/chats?bot_slug=SEU_BOT&days=30" \
  -H "Authorization: Bearer SEU_TOKEN" | jq

# Resposta esperada:
# {
#   "ok": true,
#   "bot_slug": "SEU_BOT",
#   "window_days": 30,
#   "active": 123,
#   "blocked": 12,
#   "unknown": 45
# }
```

### 7. Verificar Logs
```bash
# Após restart, verificar logs
# Deve aparecer:
# - [BOOT] features loaded
# - Nenhum erro de migration
# - Nenhum erro ao inicializar chatMemberFeature
```

### 8. Teste Manual com Usuário Real
```
1. Usuário envia /start ao bot
   → Verificar logs: [CONTACTS] Contact upserted on interaction
   → Verificar DB: chat_state = 'active'

2. Usuário bloqueia o bot
   → Aguardar 1-2 segundos
   → Verificar logs: [CHAT_MEMBER] User blocked the bot
   → Verificar DB: chat_state = 'blocked'

3. Chamar API de métricas
   → Verificar: blocked incrementou

4. Usuário desbloqueia e envia /start
   → Verificar logs: [CHAT_MEMBER] User unblocked the bot
   → Verificar DB: chat_state = 'active'
```

### 9. Monitoramento Pós-Deploy
```bash
# Monitorar logs por 5-10 minutos
tail -f logs/app.log | grep CONTACTS
tail -f logs/app.log | grep CHAT_MEMBER
tail -f logs/app.log | grep TELEGRAM.*ERROR

# Verificar se não há erros inesperados
```

### 10. Verificar Performance
```sql
-- Testar performance das queries
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM telegram_contacts
WHERE bot_slug = 'SEU_BOT'
  AND chat_state = 'active'
  AND last_interaction_at >= now() - interval '30 days';

-- Execution time deve ser < 50ms
```

## 🔧 Troubleshooting

### Problema: Migration falha ao criar enum

```sql
-- Verificar se enum já existe
SELECT typname FROM pg_type WHERE typname = 'chat_state_enum';

-- Se existir mas com valores diferentes, dropar e recriar:
DROP TYPE IF EXISTS chat_state_enum CASCADE;
-- Depois rodar a migration novamente
```

### Problema: Backfill demora muito

```sql
-- Verificar quantidade de dados
SELECT COUNT(*) FROM funnel_events;

-- Se for muito grande (>1M), considere rodar em batches
-- Editar 20251017_backfill_telegram_contacts.sql
-- Adicionar WHERE occurred_at >= 'DATA_RECENTE'
```

### Problema: Endpoint retorna 500

```bash
# Verificar logs
tail -100 logs/app.log | grep ERROR

# Verificar se TelegramContactsService foi importado
grep -r "TelegramContactsService" dist/admin/metrics.js
```

### Problema: my_chat_member não funciona

```bash
# Verificar se webhook está configurado corretamente
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq

# Verificar se allowed_updates inclui my_chat_member
# Se não, atualizar webhook:
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://SEU_DOMINIO/tg/SEU_BOT/webhook",
    "allowed_updates": ["message", "callback_query", "my_chat_member"]
  }'
```

## 🎯 Validação Final

Após deploy, executar todos estes checks:

- [ ] Tabela `telegram_contacts` existe
- [ ] Enum `chat_state_enum` criado
- [ ] Índices criados
- [ ] Backfill executado com sucesso
- [ ] Endpoint `/admin/metrics/chats` funciona
- [ ] UI exibe métricas corretamente
- [ ] Bloqueio de usuário é detectado
- [ ] Desbloqueio de usuário é detectado
- [ ] Erros 403/400 são tratados
- [ ] Logs mostram operações corretas
- [ ] Performance está adequada

## 📊 Queries de Validação

```sql
-- 1. Verificar estrutura
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'telegram_contacts';

-- 2. Verificar dados
SELECT 
  COUNT(*) as total,
  COUNT(DISTINCT bot_slug) as bots,
  MIN(first_seen_at) as oldest,
  MAX(last_interaction_at) as newest
FROM telegram_contacts;

-- 3. Verificar estados
SELECT chat_state, COUNT(*) 
FROM telegram_contacts 
GROUP BY chat_state;

-- 4. Testar métricas
SELECT 
  bot_slug,
  COUNT(*) FILTER (WHERE chat_state = 'active' AND last_interaction_at >= now() - interval '30 days') as active,
  COUNT(*) FILTER (WHERE chat_state IN ('blocked', 'deactivated')) as blocked
FROM telegram_contacts 
GROUP BY bot_slug;
```

## 🎉 Deploy Completo!

Se todos os checks passaram, o deploy foi bem-sucedido!

### Próximos Passos

1. Monitorar métricas por 24h
2. Coletar feedback dos usuários do admin
3. Ajustar janelas de tempo se necessário
4. Considerar implementar features opcionais

---

**Implementação:** Sistema de Gerenciamento de Contatos do Telegram  
**Data:** 2025-10-17  
**Branch:** cursor/gerenciar-contatos-e-estados-do-telegram-b7bf  
**Status:** ✅ Pronto para produção
