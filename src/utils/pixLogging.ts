/**
 * Utilitários para logging estruturado do funil PIX
 */

/**
 * Gera o pix_trace_id para correlação de logs
 * Usa provider_id se disponível, senão transaction_id
 */
export function generatePixTraceId(providerId?: string | null, transactionId?: string | number | null): string {
  if (providerId) {
    return `pix:${providerId}`;
  }
  if (transactionId) {
    return `tx:${transactionId}`;
  }
  return 'tx:unknown';
}

/**
 * Mascara um token/secret mostrando apenas prefixo de 6 chars e tamanho
 */
export function maskToken(token?: string | null): string {
  if (!token) {
    return 'none';
  }
  const prefix = token.slice(0, 6);
  return `${prefix}... (len=${token.length})`;
}

/**
 * Sanitiza headers removendo informações sensíveis
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization') {
      sanitized[key] = maskToken(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Extrai preview do qr_code (primeiros 12 chars)
 */
export function getQrCodePreview(qrCode?: string | null): string | null {
  if (!qrCode) {
    return null;
  }
  return qrCode.slice(0, 12);
}

/**
 * Obtém tamanho do qr_code_base64
 */
export function getQrCodeBase64Length(qrCodeBase64?: string | null): number {
  if (!qrCodeBase64) {
    return 0;
  }
  return qrCodeBase64.length;
}

/**
 * Extrai meta do bot para logging
 */
export function extractBotMeta(meta?: Record<string, unknown> | null): { bot_slug?: string } {
  if (!meta || typeof meta !== 'object') {
    return {};
  }
  
  const botSlug = 'botSlug' in meta ? String(meta.botSlug) : undefined;
  
  return botSlug ? { bot_slug: botSlug } : {};
}

/**
 * Calcula elapsed time em ms
 */
export function calculateElapsedMs(startTime: number): number {
  return Date.now() - startTime;
}

/**
 * Calcula time-to-cash (ttc) em ms
 */
export function calculateTtcMs(createdAt: Date): number {
  return Date.now() - createdAt.getTime();
}

/**
 * Cria um preview seguro do body, ocultando dados sensíveis
 */
export function createBodyPreview(body: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(body)) {
    if (key === 'split_rules' && Array.isArray(value)) {
      preview.split_count = value.length;
      preview.split_sum_cents = value.reduce((sum: number, rule: any) => {
        const cents = Number(rule?.cents ?? rule?.value_cents ?? 0);
        return sum + cents;
      }, 0);
    } else if (key === 'qr_code_base64') {
      preview.qr_code_base64_len = getQrCodeBase64Length(String(value));
    } else if (key === 'qr_code') {
      preview.qr_code_preview = getQrCodePreview(String(value));
    } else {
      preview[key] = value;
    }
  }
  
  return preview;
}
