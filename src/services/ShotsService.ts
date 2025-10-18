import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { metrics } from '../metrics.js';
import {
  getTelegramIdsForAllStarted,
  getTelegramIdsForPixGenerated,
} from '../repositories/ShotsAudienceRepo.js';
import {
  listShots as repoListShots,
  getShotWithPlans as repoGetShotWithPlans,
  findShotById,
  createShot as repoCreateShot,
  updateShot as repoUpdateShot,
  deleteShot as repoDeleteShot,
  botExists as repoBotExists,
  shotHasQueueEntries,
  shotHasSuccessfulQueue,
  getQueueStats as repoGetQueueStats,
  type ShotRow,
  type ShotPlanRow,
  type ShotTarget,
  type ShotMediaType,
  type ShotQueueStats,
  type ListShotsResult as RepoListShotsResult,
} from '../repositories/ShotsRepo.js';
import {
  listPlans as repoListPlans,
  createPlan as repoCreatePlan,
  updatePlan as repoUpdatePlan,
  deletePlan as repoDeletePlan,
  reorderPlans as repoReorderPlans,
  getPlanById,
} from '../repositories/ShotPlansRepo.js';
import { sanitizeHtml, chunkText, formatBRL } from './shots/ShotsMessageBuilder.js';

const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_INSERT_BATCH_SIZE = 500;
const INSERT_BATCH_SIZE = (() => {
  const value = Number.parseInt(process.env.SHOTS_ENQUEUE_BATCH_SIZE ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INSERT_BATCH_SIZE;
})();

export type NormalizedShotTarget = ShotTarget;

export interface EnqueueShotRecipientsResult {
  candidates: number;
  inserted: number;
  duplicates: number;
}

export interface ListShotsParams {
  botSlug: string;
  search?: string | null;
  limit: number;
  offset: number;
}

export type ListShotsResult = RepoListShotsResult;

export interface ShotPreviewResult {
  textParts: string[];
  keyboard: { text: string; callback_data: string }[][];
  media: { type: ShotMediaType; url: string; caption?: string | null } | null;
}

export interface ShotTriggerResult {
  mode: 'now' | 'schedule';
  scheduled_at: Date | null;
  stats?: EnqueueShotRecipientsResult;
}

export class ShotsServiceError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ShotsServiceError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends ShotsServiceError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends ShotsServiceError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

function sanitizeString(value: unknown, maxLength = 5000): string {
  const normalized = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = normalized.trim();
  if (trimmed.length > maxLength) {
    return trimmed.slice(0, maxLength);
  }
  return trimmed;
}

function normalizeMediaTypeInput(value: unknown): ShotMediaType {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'photo' || normalized === 'video' || normalized === 'audio' || normalized === 'document') {
    return normalized;
  }
  return 'none';
}

function normalizeTargetInput(value: unknown): ShotTarget {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'pix_generated') {
    return 'pix_generated';
  }
  return 'all_started';
}

function parseScheduledAt(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function ensureFutureDate(date: Date): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ValidationError('Data de agendamento inválida');
  }
  if (date.getTime() <= Date.now()) {
    throw new ShotsServiceError('Agendamento deve estar no futuro', 422, 'VALIDATION_ERROR');
  }
}

async function ensureShotExists(shotId: number): Promise<ShotRow> {
  const shot = await findShotById(shotId);
  if (!shot) {
    throw new NotFoundError('Shot not found');
  }
  return shot;
}

function normalizeShotTarget(target: string | null): NormalizedShotTarget {
  switch (target) {
    case 'all_started':
    case 'started':
      return 'all_started';
    case 'pix_generated':
    case 'pix_created':
      return 'pix_generated';
    default:
      throw new Error(`Unsupported shot target: ${target ?? 'null'}`);
  }
}

function normalizeScheduledAt(value: Date | string | null): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    return null;
  }

  if (typeof (value as any).toISOString === 'function') {
    const parsed = new Date((value as any).toISOString());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

async function fetchAudience(botSlug: string, target: NormalizedShotTarget): Promise<bigint[]> {
  if (target === 'all_started') {
    return getTelegramIdsForAllStarted(botSlug);
  }
  return getTelegramIdsForPixGenerated(botSlug);
}

export class ShotsService {
  async listShots(params: ListShotsParams): Promise<ListShotsResult> {
    const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.min(params.limit, 100) : 30;
    const offset = Number.isFinite(params.offset) && params.offset >= 0 ? params.offset : 0;
    const search = params.search ? sanitizeString(params.search, 200) : null;

    const result = await repoListShots({
      botSlug: sanitizeString(params.botSlug, 200).toLowerCase(),
      search,
      limit,
      offset,
    });

    logger.info(
      {
        bot_slug: params.botSlug,
        limit,
        offset,
        items: result.items.length,
      },
      '[ADMIN][SHOTS][LIST]'
    );

    return result;
  }

  async getShotWithPlans(shotId: number): Promise<{ shot: ShotRow; plans: ShotPlanRow[] }> {
    try {
      return await repoGetShotWithPlans(shotId);
    } catch (err) {
      throw new NotFoundError('Disparo não encontrado');
    }
  }

  async createShot(payload: {
    bot_slug: string;
    title?: string | null;
    copy: string;
    target: ShotTarget;
    media_type: ShotMediaType;
    media_url?: string | null;
    scheduled_at?: Date | null;
  }): Promise<ShotRow> {
    const botSlug = sanitizeString(payload.bot_slug, 200).toLowerCase();
    if (!botSlug) {
      throw new ValidationError('bot_slug obrigatório');
    }

    const exists = await repoBotExists(botSlug);
    if (!exists) {
      throw new ValidationError('Bot inexistente');
    }

    const title = payload.title ? sanitizeString(payload.title, 200) : null;
    const copy = sanitizeString(payload.copy, 8000);
    if (!copy) {
      throw new ValidationError('copy obrigatória');
    }

    const target = normalizeTargetInput(payload.target);
    const mediaType = normalizeMediaTypeInput(payload.media_type);
    const mediaUrl = mediaType === 'none' ? null : sanitizeString(payload.media_url ?? '', 2000);

    if (mediaType !== 'none' && !mediaUrl) {
      throw new ValidationError('media_url obrigatório para o tipo selecionado');
    }

    const scheduledAt = payload.scheduled_at ?? null;

    const shot = await repoCreateShot({
      bot_slug: botSlug,
      title,
      copy,
      media_url: mediaUrl,
      media_type: mediaType,
      target,
      scheduled_at: scheduledAt,
    });

    logger.info({ shot_id: shot.id, bot_slug: shot.bot_slug }, '[ADMIN][SHOTS][CREATE]');

    return shot;
  }

  async updateShot(
    shotId: number,
    payload: {
      bot_slug?: string;
      title?: string | null;
      copy?: string;
      media_type?: ShotMediaType;
      media_url?: string | null;
      target?: ShotTarget;
      scheduled_at?: Date | null;
    }
  ): Promise<ShotRow> {
    const shot = await ensureShotExists(shotId);

    const updates: Record<string, unknown> = {};

    if (payload.title !== undefined) {
      const title = payload.title ? sanitizeString(payload.title, 200) : null;
      updates.title = title;
    }

    if (payload.copy !== undefined) {
      const copy = sanitizeString(payload.copy, 8000);
      if (!copy) {
        throw new ValidationError('copy obrigatória');
      }
      updates.copy = copy;
    }

    let nextMediaType: ShotMediaType | undefined;

    if (payload.media_type !== undefined) {
      nextMediaType = normalizeMediaTypeInput(payload.media_type);
      updates.media_type = nextMediaType;
    }

    if (payload.media_url !== undefined) {
      const mediaType = nextMediaType ?? (updates.media_type as ShotMediaType | undefined) ?? shot.media_type ?? 'none';
      const mediaUrl = mediaType === 'none' ? null : sanitizeString(payload.media_url ?? '', 2000);
      if (mediaType !== 'none' && !mediaUrl) {
        throw new ValidationError('media_url obrigatório para o tipo selecionado');
      }
      updates.media_url = mediaUrl;
    } else if (nextMediaType === 'none') {
      updates.media_url = null;
    }

    if (payload.target !== undefined) {
      updates.target = normalizeTargetInput(payload.target);
    }

    if (payload.scheduled_at !== undefined) {
      const scheduledAt = payload.scheduled_at ? new Date(payload.scheduled_at) : null;
      updates.scheduled_at = scheduledAt;
    }

    if (payload.bot_slug !== undefined) {
      const newSlug = sanitizeString(payload.bot_slug, 200).toLowerCase();
      if (!newSlug) {
        throw new ValidationError('bot_slug obrigatório');
      }
      if (newSlug !== shot.bot_slug) {
        const hasQueue = await shotHasQueueEntries(shotId);
        if (hasQueue) {
          throw new ConflictError('Não é possível alterar o bot_slug com fila existente');
        }
        const exists = await repoBotExists(newSlug);
        if (!exists) {
          throw new ValidationError('Bot inexistente');
        }
        updates.bot_slug = newSlug;
      }
    }

    const updated = await repoUpdateShot(shotId, updates);
    if (!updated) {
      throw new NotFoundError('Disparo não encontrado');
    }

    logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][UPDATE]');

    return updated;
  }

  async deleteShot(shotId: number): Promise<void> {
    await ensureShotExists(shotId);

    const hasSuccess = await shotHasSuccessfulQueue(shotId);
    if (hasSuccess) {
      throw new ConflictError('Disparo já possui envios finalizados');
    }

    const deleted = await repoDeleteShot(shotId);
    if (!deleted) {
      throw new NotFoundError('Disparo não encontrado');
    }

    logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][DELETE]');
  }

  async listPlans(shotId: number): Promise<ShotPlanRow[]> {
    await ensureShotExists(shotId);
    return repoListPlans(shotId);
  }

  async createPlan(
    shotId: number,
    payload: { name: string; price_cents: number; description?: string | null }
  ): Promise<ShotPlanRow> {
    await ensureShotExists(shotId);

    const name = sanitizeString(payload.name, 200);
    if (!name) {
      throw new ValidationError('Nome do plano obrigatório');
    }

    if (!Number.isInteger(payload.price_cents) || payload.price_cents < 0) {
      throw new ValidationError('price_cents deve ser inteiro não negativo');
    }

    const description = payload.description ? sanitizeString(payload.description, 2000) : null;

    const plan = await repoCreatePlan({
      shot_id: shotId,
      name,
      price_cents: Math.trunc(payload.price_cents),
      description,
    });

    logger.info({ shot_id: shotId, plan_id: plan.id }, '[ADMIN][SHOTS][PLAN_CREATE]');

    return plan;
  }

  async updatePlan(
    shotId: number,
    planId: number,
    payload: { name?: string; price_cents?: number; description?: string | null }
  ): Promise<ShotPlanRow> {
    const plan = await getPlanById(planId);
    if (!plan || plan.shot_id !== shotId) {
      throw new NotFoundError('Plano não encontrado');
    }

    const updates: Record<string, unknown> = {};

    if (payload.name !== undefined) {
      const name = sanitizeString(payload.name, 200);
      if (!name) {
        throw new ValidationError('Nome do plano obrigatório');
      }
      updates.name = name;
    }

    if (payload.price_cents !== undefined) {
      if (!Number.isInteger(payload.price_cents) || payload.price_cents < 0) {
        throw new ValidationError('price_cents deve ser inteiro não negativo');
      }
      updates.price_cents = Math.trunc(payload.price_cents);
    }

    if (payload.description !== undefined) {
      updates.description = payload.description ? sanitizeString(payload.description, 2000) : null;
    }

    const updated = await repoUpdatePlan(shotId, planId, updates);
    if (!updated) {
      throw new NotFoundError('Plano não encontrado');
    }

    logger.info({ shot_id: shotId, plan_id: planId }, '[ADMIN][SHOTS][PLAN_UPDATE]');

    return updated;
  }

  async deletePlan(shotId: number, planId: number): Promise<void> {
    const plan = await getPlanById(planId);
    if (!plan || plan.shot_id !== shotId) {
      throw new NotFoundError('Plano não encontrado');
    }

    const deleted = await repoDeletePlan(shotId, planId);
    if (!deleted) {
      throw new NotFoundError('Plano não encontrado');
    }

    logger.info({ shot_id: shotId, plan_id: planId }, '[ADMIN][SHOTS][PLAN_DELETE]');
  }

  async reorderPlans(shotId: number, order: number[]): Promise<ShotPlanRow[]> {
    const plans = await repoListPlans(shotId);
    const planIds = new Set(plans.map((plan) => plan.id));

    for (const id of order) {
      if (!planIds.has(id)) {
        throw new ValidationError('Plano inválido na ordenação');
      }
    }

    if (order.length !== plans.length) {
      throw new ValidationError('Ordenação deve incluir todos os planos');
    }

    const reordered = await repoReorderPlans(shotId, order);

    logger.info({ shot_id: shotId, count: order.length }, '[ADMIN][SHOTS][PLAN_REORDER]');

    return reordered;
  }

  async triggerShot(
    shotId: number,
    payload: { mode: 'now' | 'schedule'; scheduled_at?: Date | null }
  ): Promise<ShotTriggerResult> {
    const shot = await ensureShotExists(shotId);

    if (payload.mode === 'now') {
      const scheduledAt = new Date();
      await repoUpdateShot(shotId, { scheduled_at: scheduledAt });
      const stats = await this.enqueueShotRecipients(shotId);
      logger.info({ shot_id: shotId, mode: 'now', stats }, '[ADMIN][SHOTS][TRIGGER]');
      return { mode: 'now', scheduled_at: scheduledAt, stats };
    }

    const scheduledAt = parseScheduledAt(payload.scheduled_at);
    if (!scheduledAt) {
      throw new ValidationError('scheduled_at obrigatório para modo schedule');
    }
    ensureFutureDate(scheduledAt);

    await repoUpdateShot(shotId, { scheduled_at: scheduledAt });

    logger.info(
      { shot_id: shotId, mode: 'schedule', scheduled_at: scheduledAt.toISOString() },
      '[ADMIN][SHOTS][TRIGGER]'
    );

    return { mode: 'schedule', scheduled_at: scheduledAt, stats: undefined };
  }

  async getShotStats(shotId: number): Promise<ShotQueueStats> {
    await ensureShotExists(shotId);
    const stats = await repoGetQueueStats(shotId);
    logger.info({ shot_id: shotId, stats }, '[ADMIN][SHOTS][STATS]');
    return stats;
  }

  async previewShot(
    shotId: number,
    payload?: {
      title?: string | null;
      copy?: string | null;
      media_type?: ShotMediaType;
      media_url?: string | null;
      plans?: Array<{ name: string; price_cents: number; description?: string | null }>;
    }
  ): Promise<ShotPreviewResult> {
    const { shot, plans } = await this.getShotWithPlans(shotId);

    const previewTitle = payload?.title !== undefined ? payload.title : shot.title;
    const previewCopy = payload?.copy !== undefined ? payload.copy : shot.copy;
    const previewMediaType = payload?.media_type ?? (shot.media_type ?? 'none');
    const previewMediaUrl = payload?.media_url !== undefined ? payload.media_url : shot.media_url;

    let previewPlans: ShotPlanRow[];
    if (payload?.plans) {
      previewPlans = payload.plans.map((plan, index) => ({
        id: plans[index]?.id ?? index + 1,
        shot_id: shotId,
        name: sanitizeString(plan.name, 200),
        price_cents: Number.isFinite(plan.price_cents) ? Math.max(0, Math.trunc(plan.price_cents)) : 0,
        description: plan.description ? sanitizeString(plan.description, 2000) : null,
        sort_order: index,
      }));
    } else {
      previewPlans = plans;
    }

    const sanitizedCopy = sanitizeHtml(previewCopy ?? '');
    const plainCopy = stripTags(sanitizedCopy).replace(/\s+/g, '');
    const useCaption =
      previewMediaType !== 'none' && !!previewMediaUrl && plainCopy.length > 0 && plainCopy.length <= TELEGRAM_CAPTION_LIMIT;

    const textParts: string[] = [];
    if (!useCaption && sanitizedCopy) {
      textParts.push(...chunkText(sanitizedCopy, TELEGRAM_TEXT_LIMIT));
    }

    const validPlans = previewPlans.filter((plan) => plan.name?.trim());
    const blocks: string[] = [];
    const buttonRows: { text: string; callback_data: string }[][] = [];
    let buttonIndex = 0;

    for (const plan of validPlans) {
      const nameHtml = sanitizeHtml(plan.name.trim());
      const descriptionHtml = plan.description ? sanitizeHtml(plan.description) : null;
      const priceCents = Number.isFinite(plan.price_cents) ? Math.max(0, Math.trunc(plan.price_cents)) : 0;
      const priceLabel = priceCents > 0 ? ` — ${formatBRL(priceCents)}` : '';
      let block = `• <b>${nameHtml}</b>${priceLabel}`;
      if (descriptionHtml) {
        block += `\n<i>${descriptionHtml}</i>`;
      }
      blocks.push(block);

      if (priceCents > 0) {
        const buttonText = `${stripTags(nameHtml)} — ${formatBRL(priceCents)}`;
        const callbackData = `downsell:${shot.id}:p${buttonIndex}`;
        buttonRows.push([{ text: buttonText, callback_data: callbackData }]);
        buttonIndex += 1;
      }
    }

    if (blocks.length > 0) {
      const titlePrefix = previewTitle ? `<b>${sanitizeHtml(previewTitle)}</b>\n\n` : '';
      const messageBody = `${titlePrefix}${blocks.join('\n\n')}`.trim();
      textParts.push(...chunkText(messageBody, TELEGRAM_TEXT_LIMIT));
    }

    const media =
      previewMediaType !== 'none' && previewMediaUrl
        ? { type: previewMediaType, url: previewMediaUrl, caption: useCaption ? sanitizedCopy : null }
        : null;

    logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][PREVIEW]');

    return {
      textParts,
      keyboard: buttonRows,
      media,
    };
  }

  async enqueueShotRecipients(shotId: number): Promise<EnqueueShotRecipientsResult> {
    if (!Number.isInteger(shotId) || shotId <= 0) {
      throw new Error('shotId must be a positive integer');
    }

    const shotRow = await ensureShotExists(shotId);

    if (!shotRow.bot_slug) {
      throw new Error(`Shot ${shotId} is missing bot_slug`);
    }

    const target = normalizeShotTarget(shotRow.target);
    const scheduledAt = normalizeScheduledAt(shotRow.scheduled_at);
    const botSlug = shotRow.bot_slug;

    const audience = await fetchAudience(botSlug, target);
    const candidates = audience.length;

    metrics.count('shots.enqueue.candidates', candidates);

    if (candidates === 0) {
      metrics.count('shots.enqueue.inserted', 0);
      metrics.count('shots.enqueue.duplicates', 0);
      logger.info(
        `[SHOTS][ENQUEUE] shot=${shotId} bot=${botSlug} target=${target} cand=0 ins=0 dup=0.`
      );
      return { candidates: 0, inserted: 0, duplicates: 0 };
    }

    let inserted = 0;

    for (let i = 0; i < audience.length; i += INSERT_BATCH_SIZE) {
      const chunk = audience.slice(i, i + INSERT_BATCH_SIZE);
      if (chunk.length === 0) {
        continue;
      }

      const chunkResult = await pool.query(
        `INSERT INTO shots_queue (
           shot_id,
           bot_slug,
           telegram_id,
           status,
           attempts,
           scheduled_at,
           next_retry_at
         )
         SELECT
           $1 AS shot_id,
           $2 AS bot_slug,
           telegram_id,
           'pending' AS status,
           0 AS attempts,
           $3 AS scheduled_at,
           NULL::timestamptz AS next_retry_at
         FROM unnest($4::bigint[]) AS t(telegram_id)
         ON CONFLICT (shot_id, telegram_id) DO NOTHING`,
        [shotId, botSlug, scheduledAt, chunk.map((id) => id.toString())]
      );

      const insertedInChunk = chunkResult.rowCount ?? 0;
      inserted += insertedInChunk;
    }

    const duplicates = Math.max(0, candidates - inserted);

    metrics.count('shots.enqueue.inserted', inserted);
    metrics.count('shots.enqueue.duplicates', duplicates);
    logger.info(
      `[SHOTS][ENQUEUE] shot=${shotId} bot=${botSlug} target=${target} cand=${candidates} ins=${inserted} dup=${duplicates}.`
    );

    return { candidates, inserted, duplicates };
  }
}

export const shotsService = new ShotsService();
