import { InlineKeyboard, type Context } from 'grammy';
import { getSettings } from '../../db/botSettings.js';
import { logger } from '../../logger.js';

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function formatBRL(value_cents: number | null | undefined): string {
  const value = Number.isFinite(value_cents) ? Math.trunc(Number(value_cents)) : 0;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
}

export interface SendPixUiOptions {
  botSlug: string;
  valueCents?: number | null;
  qrCode?: string | null;
  transactionId?: string | number | null;
}

/**
 * Envia a UI de PIX compartilhada: imagem (se configurada), instruções, código Pix Copia e Cola
 * e os botões [EFETUEI O PAGAMENTO] e [Qr code].
 */
export async function sendPixUi(ctx: Context, opts: SendPixUiOptions): Promise<void> {
  const log = logger.child({ bot_slug: opts.botSlug, tx: opts.transactionId ?? null });

  const settings = await getSettings(opts.botSlug);
  if (settings?.pix_image_url) {
    try {
      await ctx.replyWithPhoto(settings.pix_image_url);
      log.info({ pix_image_url: settings.pix_image_url }, '[PIX][UI] image sent');
    } catch (err) {
      log.warn({ err }, '[PIX][UI] image failed');
    }
  }

  const instructions = [
    '✅ Como realizar o pagamento:',
    '',
    '1️⃣ Abra o aplicativo do seu banco.',
    '',
    '2️⃣ Selecione a opção “Pagar” ou “Pix”.',
    '',
    '3️⃣ Escolha “Pix Copia e Cola”.',
    '',
    '4️⃣ Cole o código abaixo e confirme o pagamento com segurança.',
  ].join('\n');
  await ctx.reply(instructions);

  const valueFormatted = formatBRL(opts.valueCents ?? null);
  await ctx.reply(`Valor: ${valueFormatted}`);

  const qrCode = opts.qrCode ?? 'indisponível';
  await ctx.reply('Copie o código abaixo:');
  await ctx.reply(`<pre>${escapeHtml(qrCode)}</pre>`, { parse_mode: 'HTML' });

  const txId = opts.transactionId;
  if (txId) {
    const keyboard = new InlineKeyboard()
      .text('EFETUEI O PAGAMENTO', `paid:${txId}`)
      .row()
      .text('Qr code', `qr:${txId}`);

    await ctx.reply('Após efetuar o pagamento, clique no botão abaixo ⤵️', {
      reply_markup: keyboard,
    });
    log.info({ buttons: ['paid:<id>', 'qr:<id>'] }, '[PIX][UI] message sent');
  } else {
    log.warn({ has_transaction_id: false }, '[PIX][UI] transaction id missing');
  }
}
