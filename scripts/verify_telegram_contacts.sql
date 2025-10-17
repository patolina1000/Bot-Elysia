-- Script de Verificação do Sistema de Telegram Contacts
-- Execute este script para verificar a implementação

-- 1. Verificar se a tabela foi criada
SELECT 
  table_name, 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns
WHERE table_name = 'telegram_contacts'
ORDER BY ordinal_position;

-- 2. Verificar se o tipo enum foi criado
SELECT enumlabel 
FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'chat_state_enum'
ORDER BY enumsortorder;

-- 3. Verificar índices criados
SELECT 
  indexname, 
  indexdef
FROM pg_indexes
WHERE tablename = 'telegram_contacts';

-- 4. Contar registros backfilled
SELECT COUNT(*) as total_contacts
FROM telegram_contacts;

-- 5. Distribuição por estado
SELECT 
  chat_state,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM telegram_contacts
GROUP BY chat_state
ORDER BY count DESC;

-- 6. Distribuição por bot
SELECT 
  bot_slug,
  COUNT(*) as total_contacts,
  COUNT(*) FILTER (WHERE chat_state = 'active') as active,
  COUNT(*) FILTER (WHERE chat_state = 'blocked') as blocked,
  COUNT(*) FILTER (WHERE chat_state = 'deactivated') as deactivated,
  COUNT(*) FILTER (WHERE chat_state = 'unknown') as unknown
FROM telegram_contacts
GROUP BY bot_slug
ORDER BY total_contacts DESC;

-- 7. Contatos mais recentes
SELECT 
  bot_slug,
  telegram_id,
  chat_state,
  last_interaction_at,
  first_seen_at,
  username
FROM telegram_contacts
ORDER BY last_interaction_at DESC NULLS LAST
LIMIT 20;

-- 8. Contatos bloqueados recentemente
SELECT 
  bot_slug,
  telegram_id,
  blocked_at,
  unblocked_at,
  username
FROM telegram_contacts
WHERE chat_state = 'blocked'
  AND blocked_at IS NOT NULL
ORDER BY blocked_at DESC
LIMIT 10;

-- 9. Contatos que desbloquearam
SELECT 
  bot_slug,
  telegram_id,
  blocked_at,
  unblocked_at,
  EXTRACT(EPOCH FROM (unblocked_at - blocked_at))/3600 as hours_blocked,
  username
FROM telegram_contacts
WHERE unblocked_at IS NOT NULL
ORDER BY unblocked_at DESC
LIMIT 10;

-- 10. Métricas agregadas (últimos 30 dias)
SELECT 
  bot_slug,
  COUNT(*) FILTER (
    WHERE chat_state = 'active' 
    AND last_interaction_at >= now() - interval '30 days'
  ) as active_30d,
  COUNT(*) FILTER (
    WHERE chat_state IN ('blocked', 'deactivated')
  ) as blocked_or_deactivated,
  COUNT(*) as total_contacts,
  ROUND(
    COUNT(*) FILTER (WHERE chat_state = 'active' AND last_interaction_at >= now() - interval '30 days') * 100.0 / 
    NULLIF(COUNT(*), 0), 
    2
  ) as active_percentage
FROM telegram_contacts
GROUP BY bot_slug
ORDER BY total_contacts DESC;

-- 11. Verificar trigger de updated_at
SELECT 
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
FROM information_schema.triggers
WHERE event_object_table = 'telegram_contacts';

-- 12. Usuários premium
SELECT 
  bot_slug,
  COUNT(*) FILTER (WHERE is_premium = true) as premium_users,
  COUNT(*) as total_users,
  ROUND(
    COUNT(*) FILTER (WHERE is_premium = true) * 100.0 / NULLIF(COUNT(*), 0), 
    2
  ) as premium_percentage
FROM telegram_contacts
GROUP BY bot_slug
ORDER BY premium_users DESC;

-- 13. Distribuição por idioma
SELECT 
  language_code,
  COUNT(*) as users
FROM telegram_contacts
WHERE language_code IS NOT NULL
GROUP BY language_code
ORDER BY users DESC
LIMIT 10;

-- 14. Contatos sem interação há mais de 30 dias
SELECT 
  bot_slug,
  COUNT(*) as inactive_30d,
  COUNT(*) FILTER (WHERE last_interaction_at < now() - interval '90 days') as inactive_90d
FROM telegram_contacts
WHERE chat_state != 'blocked'
  AND chat_state != 'deactivated'
GROUP BY bot_slug;

-- 15. Performance check dos índices
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM telegram_contacts
WHERE bot_slug = (SELECT slug FROM bots LIMIT 1)
  AND chat_state = 'active'
  AND last_interaction_at >= now() - interval '30 days';
