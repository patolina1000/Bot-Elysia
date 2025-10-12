# 🤖 Multi-Bot Telegram Service

Serviço web completo para gerenciar múltiplos bots do Telegram com admin APIs, funil de eventos e analytics. Tudo configurável via banco de dados PostgreSQL — crie novos bots sem alterar código!

## 📋 Features

- **Multi-bot support**: Um único serviço gerencia múltiplos bots do Telegram
- **Config-driven**: Toda configuração armazenada no Postgres (tokens criptografados)
- **Admin APIs**: Crie bots, configure mensagens /start, ofertas e mais — sem código
- **Funil de eventos**: Track start, checkout_start, pix_created, purchase
- **Pagamentos modularizados**: Gateway registry com PushinPay PIX (cash-in, consulta e webhook)
- **Analytics**: APIs para métricas, conversão, breakdown por dimensão
- **Media grouping**: Álbuns com fotos+vídeos, áudios separados
- **Logging estruturado**: pino + pino-http com request_id
- **Webhook security**: Secret token validation
- **Admin Wizard UI**: Interface web simples para criar bots

## 🛠️ Tech Stack

- **Node.js 20+** com TypeScript
- **Express** para HTTP
- **grammY** para Telegram
- **PostgreSQL** com `pgcrypto` para criptografia
- **Zod** para validação
- **Pino** para logs

## 🚀 Quick Start

### 1. Pré-requisitos

- Node.js 20+
- PostgreSQL 14+
- Uma conta no Render (ou outra plataforma de deploy)

### 2. Instalação Local

```bash
# Clone o repositório
git clone <repo-url>
cd telegram-multi-bot-service

# Instale dependências
npm install

# Configure variáveis de ambiente
cp .env.example .env
# Edite .env com suas credenciais
```

### 3. Configurar Banco de Dados

Crie um banco PostgreSQL e execute as migrations:

```bash
npm run migrate
```

Isso criará todas as tabelas necessárias (`bots`, `media_assets`, `funnel_events`, `offers`, etc).

### 4. Rodar Localmente

```bash
# Desenvolvimento (com hot reload)
npm run dev

# Produção
npm run build
npm start
```

O servidor estará disponível em `http://localhost:8080`.

### 5. Abrir o Admin Wizard

Acesse `http://localhost:8080/admin-wizard.html` no navegador.

## 💳 Pagamentos PushinPay

### Criar um PIX via API

```
POST /api/payments/pushinpay/cash-in
Content-Type: application/json

{
  "value_cents": 990,
  "telegram_id": 7205343917,
  "payload_id": "abc123",
  "plan_name": "1 Semana",
  "meta": {
    "trackingParameters": {
      "utm_source": "facebook",
      "utm_medium": "paid_social",
      "utm_campaign": "teste"
    }
  }
}
```

**Resposta 201:**

```json
{
  "id": "<uuid>",
  "status": "created",
  "value_cents": 990,
  "qr_code": "...",
  "qr_code_base64": "data:image/png;base64,...",
  "notice_html": "<div class=\"text-xs opacity-70 mt-3\">...</div>"
}
```

- `value_cents` deve ser em centavos (mínimo 50)
- Mostre o QR Code usando `qr_code_base64` e exiba o `notice_html` junto ao checkout
- Os headers obrigatórios (`Authorization: Bearer`, `Accept`, `Content-Type`) são configurados automaticamente pelo serviço

### Webhook

Configure `PUBLIC_BASE_URL` para que o serviço registre o webhook público (`/webhooks/pushinpay`).
Ao receber `status = paid`, o sistema grava `purchase` no funil e, se `UTMIFY_API_TOKEN` estiver presente, dispara a notificação para a UTMify.

### Consulta manual (apenas quando necessário)

```
GET /api/payments/pushinpay/transactions/{id}
```

Use somente em casos pontuais (a PushinPay recomenda aguardar o webhook e evitar polling agressivo).

## 📦 Deploy no Render

### Build Command

```bash
npm install && npm run build && npm run migrate
```

### Start Command

```bash
npm start
```

### Variáveis de Ambiente

Configure no painel do Render:

```
PORT=8080
APP_BASE_URL=https://seu-servico.onrender.com
DATABASE_URL=postgres://user:pass@host:5432/db
ENCRYPTION_KEY=uma_senha_forte_para_pgp_sym_encrypt
ADMIN_API_TOKEN=token_admin_para_rotas_/admin
NODE_ENV=production
PUSHINPAY_TOKEN=seu_token_pushinpay
PUSHINPAY_ENV=sandbox
PUBLIC_BASE_URL=https://seu-dominio-publico.com
# PUSHINPAY_WEBHOOK_HEADER=X-PushinPay-Secret
# PUSHINPAY_WEBHOOK_SECRET=um-segredo-qualquer
# UTMIFY_API_TOKEN=token_da_utmify
# UTMIFY_PLATFORM=hotbotweb
```

## 🎯 Como Criar um Novo Bot (5 Passos)

### Via Admin Wizard (Interface Web)

1. Acesse `/admin-wizard.html`
2. Preencha API Base URL e Admin Token
3. Crie o bot (nome, slug, token do Telegram, webhook secret)
4. Configure o template /start (texto + mídias)
5. Crie ofertas (opcional)

### Via cURL

#### Passo 1: Criar Bot

```bash
curl -X POST http://localhost:8080/admin/bots \
  -H "Authorization: Bearer seu-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bot Curso X",
    "slug": "curso-x",
    "token": "123456:ABC-DEF1234ghIkl...",
    "webhook_secret": "segredo123",
    "features": {
      "core-start": true,
      "funnels": true,
      "broadcast": true,
      "payments": true
    }
  }'
```

**Resposta:**
```json
{
  "bot_id": "uuid-do-bot",
  "slug": "curso-x"
}
```

O webhook será registrado automaticamente em `APP_BASE_URL/tg/curso-x/webhook`.

#### Passo 2: Configurar /start

```bash
curl -X PUT http://localhost:8080/admin/bots/<bot-id>/templates/start \
  -H "Authorization: Bearer seu-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "👋 Bem-vindo ao *Curso X*!\n\nAqui você vai aprender tudo sobre...",
    "parse_mode": "Markdown",
    "media": [
      {"type": "photo", "media": "https://example.com/capa.jpg"},
      {"type": "video", "media": "https://example.com/teaser.mp4"},
      {"type": "audio", "media": "https://example.com/boas-vindas.mp3"}
    ]
  }'
```

**Regra de Mídia:**
- Fotos e vídeos são enviados juntos em um **álbum** (sendMediaGroup)
- Áudios são enviados **separadamente** (sendAudio)

#### Passo 3: Criar Oferta

```bash
curl -X POST http://localhost:8080/admin/offers \
  -H "Authorization: Bearer seu-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "bot_id": "<bot-id>",
    "name": "Plano Completo",
    "price_cents": 9900,
    "currency": "BRL"
  }'
```

#### Passo 4: Testar o Bot

Envie `/start` para o bot no Telegram. Você receberá:
1. Mensagem de texto
2. Álbum com fotos/vídeos
3. Áudios separados

#### Passo 5: Ver Analytics

```bash
curl "http://localhost:8080/analytics/funnel?bot_id=<bot-id>&from=2025-10-01T00:00:00Z&to=2025-10-31T23:59:59Z"
```

**Resposta:**
```json
{
  "start": 42,
  "checkout_start": 15,
  "pix_created": 8,
  "purchase_paid": 5
}
```

## 📊 Analytics APIs

### GET /analytics/funnel

Retorna contagem de eventos por tipo.

**Parâmetros:**
- `bot_id`: UUID do bot
- `from`: Data inicial (ISO 8601)
- `to`: Data final (ISO 8601)

**Exemplo:**
```bash
curl "http://localhost:8080/analytics/funnel?bot_id=<bot-id>&from=2025-10-01T00:00:00Z&to=2025-10-31T23:59:59Z"
```

### GET /analytics/funnel/by-day

Retorna série temporal de eventos.

**Parâmetros adicionais:**
- `granularity`: `day` ou `hour`

### GET /analytics/conversion

Retorna conversão por usuário ou transação.

**Parâmetros adicionais:**
- `by`: `telegram` ou `transaction`

### GET /analytics/breakdown

Retorna breakdown por dimensão (utm_source, utm_campaign, etc).

**Parâmetros adicionais:**
- `dimension`: nome da dimensão (campo em `meta` JSON)

### GET /analytics/debug/:event_id

Retorna evento completo com logs correlacionados.

## 🔐 Segurança

- Tokens dos bots são criptografados no banco usando `pgcrypto` (pgp_sym_encrypt)
- Webhooks validam `X-Telegram-Bot-Api-Secret-Token`
- Admin APIs protegidas por Bearer token
- Inputs validados com Zod

## 📁 Estrutura do Projeto

```
.
├── src/
│   ├── server.ts              # Entry point
│   ├── app.ts                 # Express app
│   ├── env.ts                 # Environment variables
│   ├── logger.ts              # Pino logger
│   ├── http/
│   │   ├── routes.ts          # Admin & analytics routes
│   │   └── middleware/
│   ├── telegram/
│   │   ├── botFactory.ts      # Bot instance factory
│   │   ├── webhookRouter.ts   # Webhook handler
│   │   ├── grammYContext.ts   # Custom context
│   │   └── features/          # Bot features (start, funnels, etc)
│   ├── services/
│   │   ├── BotRegistry.ts     # Bot CRUD + cache
│   │   ├── MediaService.ts    # Media assets
│   │   ├── OfferService.ts    # Offers
│   │   ├── FunnelService.ts   # Funnel events
│   │   └── WebhookService.ts  # Webhook registration
│   ├── db/
│   │   ├── pool.ts            # PostgreSQL pool
│   │   ├── migrations/        # SQL migrations
│   │   └── sql/               # Query snippets
│   ├── analytics/
│   │   ├── FunnelApi.ts       # Analytics routes
│   │   └── SqlSnippets.ts     # SQL queries
│   ├── jobs/
│   │   ├── runCampaigns.ts    # Broadcast job (stub)
│   │   └── housekeeping.ts    # Cleanup old logs
│   └── utils/
│       ├── telegramApi.ts     # setWebhook helper
│       ├── mediaGrouping.ts   # Album grouping logic
│       └── crypto.ts          # Encryption helpers
├── public/
│   └── admin-wizard.html      # Admin UI
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 🏃 Scripts

```bash
npm run dev          # Desenvolvimento (hot reload)
npm run build        # Compilar TypeScript
npm start            # Produção
npm run migrate      # Rodar migrations
npm run jobs:campaigns     # Job de campanhas
npm run jobs:housekeeping  # Job de limpeza
```

## 🗄️ Schema do Banco

### bots
- `id`: UUID (primary key)
- `slug`: Slug único para webhook
- `name`: Nome do bot
- `token_encrypted`: Token criptografado (pgcrypto)
- `webhook_secret`: Secret token para validação
- `enabled`: Bot ativo/inativo

### bot_features
- `bot_id`: Referência para bots
- `key`: Nome da feature (core-start, funnels, etc)
- `enabled`: Feature ativa/inativa

### templates_start
- `bot_id`: Referência para bots
- `text`: Texto de boas-vindas
- `parse_mode`: Markdown ou HTML

### media_assets
- `id`: UUID
- `bot_id`: Referência para bots
- `kind`: photo, video ou audio
- `source_url`: URL original (se enviado por URL)
- `file_id`: file_id do Telegram (após primeiro envio)

### offers
- `id`: UUID
- `bot_id`: Referência para bots
- `name`: Nome da oferta
- `price_cents`: Preço em centavos
- `currency`: Moeda (BRL, USD, etc)

### funnel_events
- `id`: BIGSERIAL
- `bot_id`: Referência para bots
- `tg_user_id`: ID do usuário no Telegram
- `event`: Tipo de evento (start, checkout_start, etc)
- `event_id`: ID determinístico (único) do evento
- `price_cents`: Valor (se aplicável)
- `transaction_id`: ID da transação (se aplicável)
- `meta`: Metadados JSON (utm_source, etc)

### users
- `id`: UUID
- `bot_id`: Referência para bots
- `tg_user_id`: ID do usuário no Telegram
- `first_seen_at`: Primeira interação
- `last_seen_at`: Última interação

### app_logs
- `id`: BIGSERIAL
- `bot_id`: Referência para bots
- `level`: info, warn, error
- `request_id`: UUID da requisição
- `message`: Mensagem do log
- `meta`: Metadados JSON

## 🐛 Troubleshooting

### Bot não responde a /start

1. Verifique se o webhook foi registrado corretamente
2. Veja os logs: `GET /admin/logs?bot_id=<bot-id>`
3. Teste manualmente: `curl https://api.telegram.org/bot<token>/getWebhookInfo`

### Erro ao criar bot

- Verifique se o token do Telegram está correto
- Verifique se o slug é único
- Verifique se o `ADMIN_API_TOKEN` está correto no header

### Migrations falham

- Verifique se o Postgres tem a extensão `pgcrypto`
- Execute manualmente: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`

## 📝 License

MIT

## 🤝 Contribuindo

Pull requests são bem-vindos! Para mudanças maiores, abra uma issue primeiro.

---

**Desenvolvido com ❤️ usando Node.js, TypeScript e grammY**
