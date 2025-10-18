const CURRENCY_LOCALE = 'pt-BR';
const CURRENCY_OPTIONS = { style: 'currency', currency: 'BRL' };

function formatCurrencyValue(cents) {
  const value = Number.isFinite(cents) ? cents / 100 : 0;
  return value.toLocaleString(CURRENCY_LOCALE, CURRENCY_OPTIONS);
}

export function toCents(value) {
  const digits = String(value ?? '')
    .replace(/[^0-9]/g, '')
    .replace(/^0+(?=\d)/, '');
  if (!digits) {
    return 0;
  }
  return Number.parseInt(digits, 10);
}

export function fromCents(value) {
  const cents = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return formatCurrencyValue(cents);
}

export function maskBRL(rawValue) {
  const cents = toCents(rawValue);
  if (!cents) {
    const normalized = String(rawValue ?? '').trim();
    return normalized === '' ? '' : fromCents(0);
  }
  return fromCents(cents);
}

export function parseDateTimeLocal(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const [datePart, timePart = ''] = value.split('T');
  const [year, month, day] = datePart.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const [hours = 0, minutes = 0] = timePart.split(':').map((part) => Number.parseInt(part, 10));
  const date = new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}
