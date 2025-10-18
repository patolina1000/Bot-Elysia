-- Insere core-start=true onde não existir
INSERT INTO bot_features (bot_id, key, enabled)
SELECT b.id, 'core-start', true
FROM bots b
LEFT JOIN bot_features f
  ON f.bot_id = b.id AND f.key = 'core-start'
WHERE f.bot_id IS NULL;

-- Garante ligado para o bot com problema (ajuste o slug se necessário)
UPDATE bot_features bf
SET enabled = true
FROM bots b
WHERE bf.bot_id = b.id
  AND bf.key = 'core-start'
  AND b.slug = 'galeria-secreta-da-hadrielle';
