# Implementação do Sistema de Gerenciamento de Contatos do Telegram

## Resumo

Implementação completa de um sistema de rastreamento e gerenciamento de contatos do Telegram, incluindo detecção de bloqueios, desbloqueios e métricas em tempo real.

## Estrutura Implementada

### 1. Tabela `telegram_contacts`

**Migration:** `src/db/migrations/20251017_create_telegram_contacts.sql`

Estrutura da tabela:
- **Chave primária:** `(bot_slug, telegram_id)`
- **Campos principais:**
  - `chat_state`: enum ('active', 'blocked', 'deactivated', 'unknown')
  - `first_seen_at`: primeira vez que o usuário foi visto
  - `last_interaction_at`: última interação do usuário
  - `blocked_at`: quando o usuário bloqueou o bot
  - `unblocked_at`: quando o usuário desbloqueou o bot
  - `updated_at`: última atualização (trigger automático)
  - `username`, `language_code`, `is_premium`: informações opcionais do usuário

**Índices:**
- `idx_contacts_slug_state`: otimiza consultas por bot e estado
- `idx_contacts_slug_last_interaction`: otimiza consultas por última interação

### 2. Backfill Inicial

**Migration:** `src/db/migrations/20251017_backfill_telegram_contacts.sql`

Popula a tabela com dados históricos de `funnel_events`:
- Extrai todos os `telegram_id` distintos por `bot_slug`
- Define `chat_state = 'unknown'` inicialmente
- Calcula `first_seen_at` e `last_interaction_at` baseado em eventos

### 3. Serviço de Gerenciamento

**Arquivo:** `src/services/TelegramContactsService.ts`

Funcionalidades:
- `upsertOnInteraction()`: atualiza contato em qualquer interação
- `markAsBlocked()`: marca contato como bloqueado
- `markAsDeactivated()`: marca contato como desativado
- `markAsActive()`: marca contato como ativo
- `getMetrics()`: calcula métricas (active, blocked, unknown)

### 4. Captura de Estados (Entrada)

**Feature:** `src/telegram/features/chatMember/index.ts`

Trata eventos `my_chat_member`:
- **Bloqueio:** status `kicked` → `chat_state = 'blocked'`
- **Desbloqueio:** status `member` (de `kicked`) → `chat_state = 'active'`
- **Início:** status `member` → `chat_state = 'active'`

**Middleware Global:** Em `src/telegram/botFactory.ts`

Rastreia todas as interações:
- Captura mensagens, comandos, callbacks
- Atualiza `last_interaction_at` automaticamente
- Define `chat_state = 'active'` se estava `unknown` ou `blocked`

### 5. Tratamento de Erros (Saída)

**Utilitário:** `src/utils/telegramErrorHandler.ts`

Funções principais:
- `handleTelegramSendError()`: processa erros da API do Telegram
- `sendSafe()`: wrapper genérico com tratamento de erros

**Erros Tratados:**
- **403 "blocked"** → marca como `blocked` (sem retry)
- **403/400 "deactivated"** → marca como `deactivated` (sem retry)
- **429 rate limit** → permite retry (não altera estado)

**Integração:**
- `src/telegram/features/payments/sendPixByChatId.ts`: envio de mensagens PIX
- `src/telegram/features/downsells/dispatcher.ts`: envio de downsells

### 6. Endpoint de Métricas Atualizado

**Arquivo:** `src/admin/metrics.ts`

**Endpoint:** `GET /admin/metrics/chats`

**Parâmetros:**
- `bot_slug` (obrigatório): slug do bot
- `days` (opcional, padrão 30): janela de dias

**Resposta:**
```json
{
  "ok": true,
  "bot_slug": "meu-bot",
  "window_days": 30,
  "active": 150,
  "blocked": 25,
  "unknown": 50
}
```

**Lógica:**
- `active`: contatos com `chat_state='active'` e `last_interaction_at` dentro da janela
- `blocked`: contatos com `chat_state IN ('blocked', 'deactivated')`
- `unknown`: demais contatos (sem interação na janela ou estado unknown)

### 7. Integração com UI

**Arquivo:** `public/admin-wizard.html`

Já existente:
- Card "📊 Métricas" que consome o endpoint
- Função `updateMetricsCard()` que atualiza os números
- Atualização automática ao trocar de bot

## Fluxo de Funcionamento

### Cenário 1: Novo Usuário

1. Usuário envia `/start`
2. Middleware global captura a interação
3. `upsertOnInteraction()` cria registro:
   - `chat_state = 'active'`
   - `last_interaction_at = now()`
4. Métrica `active` incrementa

### Cenário 2: Usuário Bloqueia o Bot

1. Telegram envia evento `my_chat_member` com `status: kicked`
2. Feature `chatMember` processa o evento
3. `markAsBlocked()` atualiza:
   - `chat_state = 'blocked'`
   - `blocked_at = now()`
4. Métrica `blocked` incrementa, `active` decrementa

### Cenário 3: Tentativa de Envio para Usuário Bloqueado

1. Sistema tenta enviar downsell/PIX
2. API do Telegram retorna erro 403 "blocked"
3. `handleTelegramSendError()` detecta o erro
4. `markAsBlocked()` atualiza o estado
5. Envio é cancelado (sem retry)

### Cenário 4: Usuário Desbloqueia

1. Usuário envia `/start` novamente
2. Telegram envia evento `my_chat_member` com transição `kicked → member`
3. `markAsActive()` atualiza:
   - `chat_state = 'active'`
   - `unblocked_at = now()`
   - `last_interaction_at = now()`
4. Métrica `active` incrementa, `blocked` decrementa

### Cenário 5: Usuário Inativo

1. Usuário não interage há 30+ dias
2. `last_interaction_at` está fora da janela
3. Métrica `active` não conta este usuário
4. Contabilizado em `unknown`

## Aplicação das Migrations

Para aplicar as migrations no banco de dados:

```bash
# As migrations são aplicadas automaticamente ao iniciar a aplicação
npm start

# Ou manualmente via script de migrations
node dist/db/runMigrations.js
```

## Testes Manuais

### 1. Teste de Início

```
1. Usuário: enviar /start ao bot
2. Verificar: estado deve ser 'active'
3. API: GET /admin/metrics/chats?bot_slug=SEU_BOT&days=30
4. Esperado: "active" incrementou
```

### 2. Teste de Bloqueio

```
1. Usuário: bloquear o bot
2. Aguardar: evento my_chat_member ser processado (~1-2s)
3. API: GET /admin/metrics/chats?bot_slug=SEU_BOT&days=30
4. Esperado: "blocked" incrementou, "active" decrementou
```

### 3. Teste de Desbloqueio

```
1. Usuário: desbloquear o bot
2. Usuário: enviar /start
3. API: GET /admin/metrics/chats?bot_slug=SEU_BOT&days=30
4. Esperado: "active" incrementou, "blocked" decrementou
```

### 4. Teste de Inatividade

```
1. Consultar usuário sem interação há 30+ dias
2. API: GET /admin/metrics/chats?bot_slug=SEU_BOT&days=30
3. Esperado: usuário não aparece em "active", aparece em "unknown"
```

### 5. Teste de Envio com Erro

```
1. Agendar downsell para usuário bloqueado
2. Worker tentar enviar
3. Verificar logs: erro 403 detectado
4. Verificar: estado atualizado para 'blocked'
5. Verificar: job marcado como erro/skipped
```

## Verificação no Banco de Dados

### Consultar contatos por estado

```sql
SELECT chat_state, COUNT(*) 
FROM telegram_contacts 
WHERE bot_slug = 'meu-bot'
GROUP BY chat_state;
```

### Ver últimas interações

```sql
SELECT telegram_id, chat_state, last_interaction_at, blocked_at
FROM telegram_contacts 
WHERE bot_slug = 'meu-bot'
ORDER BY last_interaction_at DESC NULLS LAST
LIMIT 10;
```

### Métricas calculadas

```sql
SELECT
  COUNT(*) FILTER (
    WHERE chat_state = 'active' 
    AND last_interaction_at >= now() - interval '30 days'
  ) as active,
  COUNT(*) FILTER (
    WHERE chat_state IN ('blocked', 'deactivated')
  ) as blocked,
  COUNT(*) as total
FROM telegram_contacts
WHERE bot_slug = 'meu-bot';
```

## Critérios de Aceite ✅

- [x] Tabela `telegram_contacts` criada com chave única (bot_slug, telegram_id)
- [x] Índices criados para otimização de queries
- [x] Backfill inicial populando dados históricos
- [x] Captura de `my_chat_member` para bloqueios/desbloqueios
- [x] Upsert automático em todas as interações
- [x] Tratamento de erros 403/400 no envio de mensagens
- [x] Endpoint de métricas usando `telegram_contacts`
- [x] UI atualiza métricas ao trocar de bot
- [x] Métricas variam corretamente com ações do usuário
- [x] Performance adequada (índices corretos)

## Arquivos Modificados/Criados

### Novos Arquivos
- `src/db/migrations/20251017_create_telegram_contacts.sql`
- `src/db/migrations/20251017_backfill_telegram_contacts.sql`
- `src/services/TelegramContactsService.ts`
- `src/telegram/features/chatMember/index.ts`
- `src/utils/telegramErrorHandler.ts`
- `TELEGRAM_CONTACTS_IMPLEMENTATION.md` (este arquivo)

### Arquivos Modificados
- `src/admin/metrics.ts` - Atualizado para usar TelegramContactsService
- `src/telegram/botFactory.ts` - Adicionado middleware de rastreamento e chatMemberFeature
- `src/telegram/features/payments/sendPixByChatId.ts` - Adicionado tratamento de erros
- `src/telegram/features/downsells/dispatcher.ts` - Adicionado tratamento de erros

## Notas Importantes

1. **Compatibilidade:** O sistema mantém compatibilidade com dados existentes via backfill
2. **Performance:** Índices garantem consultas rápidas mesmo com milhões de contatos
3. **Idempotência:** Todas as operações são idempotentes (podem ser executadas múltiplas vezes)
4. **Trigger:** `updated_at` é atualizado automaticamente por trigger
5. **Rate Limits:** Erros 429 são respeitados e não alteram o estado do contato

## Próximos Passos (Opcional)

1. Dashboard de análise de retenção
2. Alertas automáticos para taxa alta de bloqueios
3. Segmentação de usuários por engajamento
4. Relatórios de churn (usuários que bloquearam)
5. Re-engajamento automático de usuários inativos
