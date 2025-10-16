export interface ExtraPlan {
  label: string;
  price_cents: number;
}

export interface BotDownsell {
  id: number;
  bot_slug: string;
  plan_label: string | null;
  price_cents: number | null;
  copy: string | null;
  pre_button_text: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | 'audio' | 'gif' | null;
  trigger: 'after_start' | 'after_pix';
  delay_minutes: number;
  sort_order: number | null;
  active: boolean;
  extra_plans: ExtraPlan[];
}
