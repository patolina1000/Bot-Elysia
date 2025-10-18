-- shots_sent: garante chave única para o upsert do worker
-- cobre ON CONFLICT (shot_id, telegram_id)
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_sent_shot_id_telegram_id
ON public.shots_sent (shot_id, telegram_id);
