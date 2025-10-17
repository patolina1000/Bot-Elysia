# Sistema de Disparos em Massa - Implementação Completa

## ✅ Status: IMPLEMENTADO

Sistema de disparos em massa (shots) implementado com sucesso, permitindo envio de mensagens para públicos segmentados via Telegram.

---

## 📋 Checklist de Implementação

### ✅ Tarefa A — Modelo / Banco

**Tabelas criadas:**

1. **`shots_queue`** (`src/db/migrations/20251017_create_shots_queue.sql`)
   - `id` (bigserial PK)
   - `bot_slug` (text, NOT NULL) ✅
   - `target` (enum: `started` | `pix_created`) ✅
   - `copy` (text, NOT NULL) ✅
   - `media_url` (text, opcional)
   - `media_type` (enum: `photo` | `video` | `audio` | `none`) ✅
   - `scheduled_at` (timestamptz NOT NULL, default now()) ✅
   - `status` (enum: `pending` | `running` | `sent` | `skipped` | `error`) ✅
   - `attempt_count` (int default 0) ✅
   - `last_error` (text)
   - `created_at` / `updated_at` (timestamptz) ✅

2. **`shots_sent`** (`src/db/migrations/20251017_create_shots_sent.sql`)
   - `shot_id` (FK para shots_queue)
   - `bot_slug` (text NOT NULL) ✅
   - `telegram_id` (bigint NOT NULL) ✅
   - `status` (sent | skipped | error) ✅
   - `error` (text)
   - `sent_at` (timestamptz)
   - PK: `(shot_id, telegram_id)`

**Índices criados:**
- `idx_shots_queue_scheduled` em `(status, scheduled_at)` ✅
- `idx_shots_queue_slug` em `(bot_slug, status, scheduled_at)` ✅
- `idx_shots_sent_shot_id` em `(shot_id, status)` ✅
- `idx_shots_sent_slug_time` em `(bot_slug, sent_at DESC)` ✅

---

### ✅ Tarefa B — API Admin

**Arquivo:** `src/admin/shots.ts`

Rotas implementadas com autenticação Bearer:

1. **POST /admin/api/shots** ✅
   - Cria novo disparo
   - Valida `bot_slug` existente
   - Valida `target` ∈ {started, pix_created}
   - `scheduled_at` default now()

2. **GET /admin/api/shots?bot_slug=...** ✅
   - Lista disparos do bot
   - Inclui estatísticas básicas para disparos enviados

3. **PATCH /admin/api/shots/:id** ✅
   - Edita disparo pendente
   - Permite alterar: copy, media_url, media_type, scheduled_at
   - Só funciona com status='pending'

4. **DELETE /admin/api/shots/:id** ✅
   - Cancela disparo pendente
   - Só funciona com status='pending'

5. **GET /admin/api/shots/:id/stats** ✅
   - Retorna estatísticas detalhadas: total, sent, skipped, error

---

### ✅ Tarefa C — Seleção de Público

**Arquivo:** `src/services/shots/audienceSelector.ts`

**Base:** Sempre exclui `chat_state IN ('blocked', 'deactivated')` de `telegram_contacts` ✅

**Target = started:** ✅
- Seleciona `telegram_contacts` do bot_slug com `chat_state != 'blocked'`
- Opcional: filtro de recência por `last_interaction_at >= now() - interval 'N days'`
- Ordenação: `last_interaction_at DESC` (leads quentes primeiro)

**Target = pix_created:** ✅
- Busca usuários com PIX criado via:
  - `funnel_events` com evento 'pix_created' ou 'checkout_pix_created'
  - OU `payment_transactions` com status 'created' ou 'paid'
- Interseção com `telegram_contacts` excluindo bloqueados
- Ordenação: `last_interaction_at DESC`

**Função auxiliar:**
- `estimateAudienceSize()`: Estima tamanho do público sem carregar todos os membros ✅

---

### ✅ Tarefa D — Worker de Disparos

**Arquivo:** `src/services/shots/worker.ts`

**Características:**

1. **Picker (a cada 10 segundos):** ✅
   - Busca 1 job `pending` com `scheduled_at <= now()`
   - Marca como `running` usando SELECT FOR UPDATE SKIP LOCKED

2. **Execução:** ✅
   - Gera lista de telegram_id conforme Tarefa C
   - Envia em sub-lotes de 50 usuários por vez
   - Concorrência: 10 envios simultâneos
   - Rate-limit: ~25 req/s (respeitando limites do Telegram)

3. **Tratamento de erros por usuário:** ✅
   - **403 "blocked"**: marca `shots_sent.status='skipped'` + atualiza `telegram_contacts.chat_state='blocked'`
   - **"user is deactivated"**: marca `skipped` + atualiza `chat_state='deactivated'`
   - **429 (rate limit)**: aplica backoff de 30s, depois retenta 1x
   - **Sucesso**: marca `shots_sent.status='sent'`

4. **Finalização:** ✅
   - Se ≥1 erro não-transitório: `status='error'` com `last_error`
   - Caso contrário: `status='sent'`
   - Sempre atualiza `attempt_count` e `updated_at`

5. **Proteções:** ✅
   - `resetStuckJobs()`: Jobs `running` por >30 min voltam a `pending` (máx. 3 tentativas)
   - Advisory lock para evitar worker concorrente

---

### ✅ Tarefa E — Envio por Tipo de Mídia

**Implementado em:** `src/services/shots/worker.ts` → função `sendMessageByType()`

- **media_type='photo'**: `sendPhoto` + caption (a copy) ✅
- **media_type='video'**: `sendVideo` + caption ✅
- **media_type='audio'**: `sendAudio` + mensagem separada com copy ✅
- **media_type='none'**: `sendMessage` com a copy ✅

**Formatação:** ✅
- `parse_mode: 'HTML'`
- `disable_web_page_preview: true` (para textos sem mídia)
- Usa `sendSafe()` para tratamento consistente de erros

---

### ✅ Tarefa F — Telemetria & Segurança

**Logs implementados:** ✅
- `[SHOTS][WORKER][TICK]`: Cada execução do worker
- `[SHOTS][AUDIENCE]`: Seleção de público (bot_slug, target, count)
- `[SHOTS][WORKER] processing batch`: Progresso de cada lote
- `[SHOTS][WORKER] batch completed`: Resultado (sent, skipped, errors)
- `[SHOTS][WORKER] job completed`: Resumo final do disparo

**Contadores:** ✅
- Total público selecionado
- Total enviados (sent)
- Total pulados (skipped)
- Total erros (error)

**Proteções:** ✅
- Advisory lock (key: 4839202) previne execução concorrente
- `resetStuckJobs(30)`: Timeout de 30 min para jobs travados
- Máximo 3 tentativas por job (`attempt_count`)
- Rate-limit: 25 req/s com chunks de 10 concurrent requests

---

### ✅ Tarefa G — Integração UI

**Arquivo modificado:** `public/admin-wizard.html`

**Funções JavaScript implementadas:**

1. **`loadShots()`** ✅
   - Chama `GET /admin/api/shots?bot_slug=...`
   - Renderiza cards de disparos
   - Mostra estatísticas para disparos enviados
   - Auto-recarrega quando slug do bot muda

2. **`saveShotForm()`** ✅
   - Coleta dados do formulário (público, copy, mídia, agendamento)
   - Valida campos obrigatórios
   - Chama `POST /admin/api/shots`
   - Fecha modal e recarrega lista após sucesso

3. **`deleteShotById(id)`** ✅
   - Confirma cancelamento
   - Chama `DELETE /admin/api/shots/:id`
   - Recarrega lista após sucesso

4. **`renderShotCard(shot)`** ✅
   - Exibe status, público-alvo, data/hora agendada
   - Mostra estatísticas (enviados, pulados, erros) se disponível
   - Botão "Cancelar" para disparos pendentes

**Event listeners:** ✅
- Botões de seleção de público (chips: /start vs PIX)
- Botões de envio (segmented control: Agora vs Programar)
- Auto-load ao trocar de bot
- Integração com datepicker para agendamento

---

## 🎯 Critérios de Aceite

| Critério | Status |
|----------|--------|
| ✅ Criar, listar, editar, cancelar disparo por slug | ✅ IMPLEMENTADO |
| ✅ Worker busca pending, roda com rate-limit estável e atualiza shots_sent | ✅ IMPLEMENTADO |
| ✅ Público "/start" e "PIX criado" funcionando e excluindo bloqueados | ✅ IMPLEMENTADO |
| ✅ 403/"deactivated" atualiza telegram_contacts | ✅ IMPLEMENTADO |
| ✅ Card de métricas varia após disparo grande (active↓, blocked↑) | ✅ IMPLEMENTADO |
| ✅ Sem "null bot_slug" em lugar nenhum | ✅ VALIDADO |
| ✅ Logs claros; sem 429 em cascata | ✅ IMPLEMENTADO |

---

## 📁 Arquivos Criados/Modificados

### Novos Arquivos:
1. `src/db/migrations/20251017_create_shots_queue.sql`
2. `src/db/migrations/20251017_create_shots_sent.sql`
3. `src/db/shotsQueue.ts`
4. `src/db/shotsSent.ts`
5. `src/admin/shots.ts`
6. `src/services/shots/audienceSelector.ts`
7. `src/services/shots/worker.ts`

### Arquivos Modificados:
1. `src/app.ts` - Registra rotas de shots
2. `src/server.ts` - Inicia worker de shots
3. `public/admin-wizard.html` - Integração UI com API REST

---

## 🚀 Como Usar

### 1. Criar Disparo

Na UI Admin:
1. Selecione um bot no dropdown
2. Clique em "Novo disparo"
3. Escolha o público-alvo (/start ou PIX)
4. Escolha quando enviar (Agora ou Programar)
5. Escreva a mensagem (copy)
6. Opcional: adicione mídia (URL)
7. Clique em "Salvar"

### 2. Acompanhar Disparos

- A lista mostra todos os disparos do bot selecionado
- Status: Pendente, Rodando, Enviado, Erro
- Estatísticas aparecem após envio completo
- Botão "Cancelar" disponível para disparos pendentes

### 3. Worker Automático

O worker roda automaticamente:
- Verifica jobs pendentes a cada 10 segundos
- Processa 1 disparo por vez (para não sobrecarregar)
- Envia em lotes de 50 usuários
- Rate-limit: 25 req/s respeitando limites do Telegram
- Auto-recuperação de jobs travados (>30 min)

---

## 🔧 Configuração

Nenhuma configuração adicional necessária. O sistema usa:
- Token de autenticação Admin existente
- Pool de conexões PostgreSQL existente
- Bot registry existente (BotFactory)
- Serviço de contatos Telegram existente

---

## 📊 Monitoramento

### Logs importantes:
```
[SHOTS][WORKER][TICK] - Cada verificação do worker
[SHOTS][AUDIENCE] - Tamanho do público selecionado
[SHOTS][WORKER] processing batch - Progresso de envio
[SHOTS][WORKER] job completed - Resultado final
```

### Queries úteis:
```sql
-- Verificar disparos pendentes
SELECT * FROM shots_queue WHERE status = 'pending' ORDER BY scheduled_at;

-- Ver estatísticas de um disparo
SELECT status, COUNT(*) FROM shots_sent WHERE shot_id = 123 GROUP BY status;

-- Jobs travados (running > 30min)
SELECT * FROM shots_queue WHERE status = 'running' AND updated_at < now() - interval '30 minutes';
```

---

## ✨ Melhorias Futuras (Opcionais)

1. **Filtros avançados de público:**
   - Por data de último PIX
   - Por valor de transação
   - Por tags/segmentos customizados

2. **Templates de mensagem:**
   - Salvar mensagens frequentes
   - Variáveis dinâmicas (nome, valor, etc.)

3. **A/B Testing:**
   - Enviar versões diferentes para grupos
   - Comparar performance

4. **Relatórios detalhados:**
   - Taxa de entrega
   - Taxa de bloqueio
   - Horários de melhor engajamento

---

## 🎉 Conclusão

Sistema de disparos em massa implementado com sucesso! ✅

Todas as tarefas foram concluídas conforme especificado:
- ✅ Banco de dados e migrations
- ✅ API REST completa
- ✅ Seleção inteligente de público
- ✅ Worker robusto com rate-limiting
- ✅ Suporte a múltiplos tipos de mídia
- ✅ Telemetria e logs detalhados
- ✅ UI integrada e funcional

O sistema está pronto para uso em produção! 🚀
