import { Markup } from 'telegraf';
import type * as TT from 'telegraf/typings/core/types/typegram';
import type { BotSettings } from '../../../db/botSettings.js';
import type { PaymentTransaction } from '../../../db/payments.js';

const DEFAULT_PIX_INSTRUCTIONS = [
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

function sanitizeBaseUrl(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }

  return raw.trim().replace(/\/$/, '');
}

export function buildPixInstructionText(_settings: BotSettings, _tx: PaymentTransaction): string {
  return DEFAULT_PIX_INSTRUCTIONS;
}

export function buildPixEmvBlock(tx: PaymentTransaction): string {
  if (!tx.qr_code) {
    throw new Error('Código PIX indisponível.');
  }

  return `<pre>${escapeHtml(tx.qr_code)}</pre>`;
}

export function buildPixKeyboard(externalId: string, baseUrl: string): TT.InlineKeyboardMarkup {
  const fallbackBaseUrl = sanitizeBaseUrl(process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? '');
  const providedBaseUrl = sanitizeBaseUrl(baseUrl);
  const resolvedBaseUrl = providedBaseUrl || fallbackBaseUrl;
  const encodedExternalId = encodeURIComponent(externalId);
  const qrUrl = resolvedBaseUrl
    ? `${resolvedBaseUrl}/miniapp/qr?tx=${encodedExternalId}`
    : `/miniapp/qr?tx=${encodedExternalId}`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('EFETUEI O PAGAMENTO', `paid:${externalId}`)],
    [Markup.button.webApp('Qr code', qrUrl)],
  ]);

  return inlineKeyboard.reply_markup as TT.InlineKeyboardMarkup;
}
