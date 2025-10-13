import { InlineKeyboard, type Context } from 'grammy';
import { getSettings } from '../../db/botSettings.js';
import { logger } from '../../logger.js';

function formatBRL(valueInCents: number | null | undefined): string {
  const cents = Number.isFinite(valueInCents) ? Math.trunc(Number(valueInCents)) : 0;
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\_*\[\]()~`>#+=|{}.!-]/g, (char) => `\\${char}`);
}

export interface SendPixUiTransactionLike {
  external_id?: string | number | null;
  id?: string | number | null;
  value_cents?: number | null;
  qr_code?: string | null;
}

export interface SendPixUiOptions {
  botSlug: string;
  username?: string | null;
}

const INSTRUCTIONS =
  '✅ Como realizar o pagamento:\n' +
  '1) Abra o app do seu banco.\n' +
  '2) Toque em *Pagar* ou *Pix*.\n' +
  '3) Escolha *Pix Copia e Cola*.\n' +
  '4) Cole o código abaixo e confirme o pagamento.';

/**
 * Envia a UI de PIX compartilhada: imagem (se configurada), instruções, código Pix Copia e Cola
 * e os botões [EFETUEI O PAGAMENTO] e [Qr code].
 */
export async function sendPixUi(
  ctx: Context,
  tx: SendPixUiTransactionLike,
  opts: SendPixUiOptions
): Promise<void> {
  const txId = tx?.external_id ?? tx?.id ?? null;
  const log = logger.child({ bot_slug: opts.botSlug, tx: txId });

  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  try {
    settings = await getSettings(opts.botSlug);
  } catch (err) {
    log.warn({ err }, '[PIX][UI] settings fetch failed');
  }

  if (settings?.pix_image_url) {
    try {
      await ctx.replyWithPhoto(settings.pix_image_url, { caption: INSTRUCTIONS, parse_mode: 'Markdown' });
      log.info('[PIX][UI] instruction image sent');
    } catch (err) {
      log.warn({ err }, '[PIX][UI] instruction image failed');
    }
  } else {
    await ctx.reply(INSTRUCTIONS, { parse_mode: 'Markdown' });
  }

  const username = escapeMarkdown(
    (opts.username ?? ctx.from?.first_name ?? ctx.from?.username ?? 'cliente').toString()
  );
  const money = formatBRL(tx?.value_cents ?? 0);
  const copiaCola = tx?.qr_code ?? 'indisponível';

  const message =
    `✅ PIX criado para *${username}*\n` +
    `Valor: *${money}*\n\n` +
    'Copia e Cola:\n' +
    `\`${copiaCola}\``;

  const keyboard = txId
    ? new InlineKeyboard()
        .text('EFETUEI O PAGAMENTO', `paid:${txId}`)
        .row()
        .text('Qr code', `qr:${txId}`)
    : null;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard ?? undefined,
  });

  if (keyboard) {
    log.info({ buttons: ['paid:<id>', 'qr:<id>'] }, '[PIX][UI] message sent');
  } else {
    log.warn({ has_transaction_id: false }, '[PIX][UI] transaction id missing');
  }
}
