import { InlineKeyboard } from 'grammy';

export function formatPriceBRL(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

export interface DownsellExtraPlan {
  label: string;
  price_cents: number;
}

export function buildDownsellKeyboard(
  downsellId: number,
  options: { planLabel: string | null; mainPriceCents: number | null; extraPlans: DownsellExtraPlan[] }
): InlineKeyboard | null {
  const buttons: { text: string; data: string }[] = [];
  const trimmedLabel = options.planLabel?.trim() ?? '';
  const mainPrice =
    typeof options.mainPriceCents === 'number' &&
    Number.isFinite(options.mainPriceCents) &&
    options.mainPriceCents > 0
      ? Math.round(options.mainPriceCents)
      : null;

  if (mainPrice) {
    const priceBRL = formatPriceBRL(mainPrice);
    const buttonLabel = trimmedLabel ? trimmedLabel : 'Oferta especial';
    buttons.push({
      text: `${buttonLabel} — R$ ${priceBRL}`,
      data: `downsell:${downsellId}:p0`,
    });
  }

  const extras = Array.isArray(options.extraPlans) ? options.extraPlans : [];
  let extraIndex = 1;
  for (const plan of extras) {
    const label = typeof plan?.label === 'string' ? plan.label.trim() : '';
    const cents = Number(plan?.price_cents);
    if (!label || !Number.isFinite(cents) || cents <= 0) {
      continue;
    }
    const priceBRL = formatPriceBRL(Math.round(cents));
    buttons.push({
      text: `${label} — R$ ${priceBRL}`,
      data: `downsell:${downsellId}:p${extraIndex}`,
    });
    extraIndex += 1;
  }

  if (buttons.length === 0) {
    return null;
  }

  const keyboard = new InlineKeyboard();
  buttons.forEach((btn, index) => {
    if (index > 0) {
      keyboard.row();
    }
    keyboard.text(btn.text, btn.data);
  });

  return keyboard;
}

