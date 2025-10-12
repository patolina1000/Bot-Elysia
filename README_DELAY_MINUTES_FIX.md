# Fix: delay_minutes Field Handling

## 🎯 Resumo

Este branch (`cursor/fix-delay-minutes-field-handling-a886`) contém a análise e verificação da correção dos erros `422 invalid_delay` e `500 downsells_upsert_failed`.

**Resultado**: ✅ **Todo o código já está correto. Apenas as migrations precisam ser executadas.**

---

## 📚 Documentação

- **Análise Completa**: [`DELAY_MINUTES_FIX_SUMMARY.md`](./DELAY_MINUTES_FIX_SUMMARY.md)

---

## 🚀 Quick Start

### 1. Executar Migrations

```bash
npm run migrate
```

### 2. Verificar Schema

```bash
npm run verify:downsells
```

### 3. Testar delay_minutes (Opcional)

```bash
npm run test:delay-minutes
```

---

## ✅ O que foi verificado

| Item | Status | Localização |
|------|--------|-------------|
| Frontend envia `delay_minutes` | ✅ | `public/admin-wizard.html:3334` |
| Input HTML valida 5-60 | ✅ | `public/admin-wizard.html:1375` |
| Backend aceita snake_case | ✅ | `src/admin/bots.ts:308` |
| Backend aceita camelCase | ✅ | `src/admin/bots.ts:308` |
| Backend valida 5-60 | ✅ | `src/admin/bots.ts:332-334` |
| Migration define coluna | ✅ | `src/db/migrations/20251012_downsells.sql:6` |
| Constraint CHECK no DB | ✅ | `src/db/migrations/20251012_downsells.sql:6` |
| TypeScript usa snake_case | ✅ | `src/db/downsells.ts:98,139` |
| Tabela de métricas | ✅ | `src/db/migrations/20251012_downsells_metrics.sql` |

---

## 🧪 Testes Disponíveis

### Teste Automatizado

```bash
npm run test:delay-minutes
```

**O que testa:**
- ✅ Coluna `delay_minutes` existe
- ✅ Constraint CHECK está aplicada
- ✅ Valores válidos (5-60) são aceitos
- ✅ Valores inválidos (<5 ou >60) são rejeitados
- ✅ INSERT funciona
- ✅ UPDATE funciona
- ✅ SELECT retorna valor correto

### Teste Manual (SQL)

```sql
-- Verificar coluna
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'downsells' 
  AND column_name = 'delay_minutes';

-- Verificar constraint
SELECT conname, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'downsells'::regclass 
  AND pg_get_constraintdef(oid) LIKE '%delay_minutes%';

-- Testar insert válido
INSERT INTO downsells (bot_slug, trigger_kind, delay_minutes, title, price_cents)
VALUES ('test', 'after_start', 15, 'Test', 100);

-- Testar insert inválido (deve falhar)
INSERT INTO downsells (bot_slug, trigger_kind, delay_minutes, title, price_cents)
VALUES ('test', 'after_start', 3, 'Test', 100);
```

### Teste via API (cURL)

```bash
# Configurar token
export ADMIN_TOKEN="seu-token-aqui"

# Teste com delay_minutes válido (15)
curl -X POST http://localhost:3000/admin/api/downsells/upsert \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bot_slug": "test-bot",
    "trigger_kind": "after_start",
    "delay_minutes": 15,
    "title": "Teste API",
    "price_cents": 990
  }'

# Teste com delay_minutes inválido (3) - deve retornar 422
curl -X POST http://localhost:3000/admin/api/downsells/upsert \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bot_slug": "test-bot",
    "trigger_kind": "after_start",
    "delay_minutes": 3,
    "title": "Teste API",
    "price_cents": 990
  }'
```

---

## 📋 Checklist de Deploy

Antes de mergear/deployar:

- [ ] Executar `npm run migrate` no ambiente de staging
- [ ] Executar `npm run verify:downsells` para confirmar schema
- [ ] (Opcional) Executar `npm run test:delay-minutes` para testar funcionalidade
- [ ] Testar criação de downsell via interface admin
- [ ] Testar edição de downsell existente
- [ ] Verificar logs para erros 422/500 relacionados a `delay_minutes`
- [ ] Executar migrations em produção
- [ ] Monitorar logs após deploy

---

## 🐛 Troubleshooting

### Erro: "column delay_minutes does not exist"

**Solução**: Execute as migrations
```bash
npm run migrate
```

### Erro: "delay_minutes deve ser entre 5 e 60"

**Esperado**: Esta é a validação funcionando corretamente. Use valores entre 5 e 60.

### Migrations já aplicadas mas erro persiste

Verifique se a migration foi realmente aplicada:

```sql
SELECT * FROM _schema_migrations 
WHERE filename = '20251012_downsells.sql';
```

Se não aparecer, a migration não foi aplicada. Execute novamente.

### Teste automatizado falha

1. Verifique se o banco está acessível
2. Verifique se DATABASE_URL está configurado em `.env`
3. Execute migrations: `npm run migrate`
4. Tente novamente: `npm run test:delay-minutes`

---

## 📖 Referências

- [Análise Completa do Fix](./DELAY_MINUTES_FIX_SUMMARY.md)
- [Migration Downsells](./src/db/migrations/20251012_downsells.sql)
- [Migration Métricas](./src/db/migrations/20251012_downsells_metrics.sql)
- [Código Backend](./src/admin/bots.ts)
- [Código Frontend](./public/admin-wizard.html)
- [Database Layer](./src/db/downsells.ts)

---

## 📞 Suporte

Se encontrar problemas:

1. Leia [`DELAY_MINUTES_FIX_SUMMARY.md`](./DELAY_MINUTES_FIX_SUMMARY.md)
2. Execute `npm run verify:downsells`
3. Execute `npm run test:delay-minutes`
4. Verifique logs do backend para detalhes do erro

---

## ✨ Scripts Adicionados

- `npm run test:delay-minutes` - Testa funcionalidade do campo delay_minutes
- `npm run verify:downsells` - Verifica schema das tabelas de downsells (já existia)
- `npm run migrate` - Executa migrations pendentes (já existia)
