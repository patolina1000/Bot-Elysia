import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from '@grammyjs/types';
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

export function resolvePixMiniAppUrl(externalId: string, baseUrl: string): string {
  const fallbackBaseUrl = sanitizeBaseUrl(process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? '');
  const providedBaseUrl = sanitizeBaseUrl(baseUrl);
  const resolvedBaseUrl = providedBaseUrl || fallbackBaseUrl;
  const encodedExternalId = encodeURIComponent(externalId);
  const qrUrl = resolvedBaseUrl
    ? `${resolvedBaseUrl}/miniapp/qr?tx=${encodedExternalId}`
    : `/miniapp/qr?tx=${encodedExternalId}`;

  return qrUrl;
}

export function buildPixKeyboard(opts: {
  miniAppUrl: string;
  confirmCallbackData: string;
  supportUrl?: string;
}): InlineKeyboardMarkup {
  const keyboard = new InlineKeyboard()
    .text('EFETUEI O PAGAMENTO', opts.confirmCallbackData)
    .row()
    .webApp('Qr code', opts.miniAppUrl);

  if (opts.supportUrl) {
    keyboard.row().url('Suporte', opts.supportUrl);
  }

  return keyboard;
}
