export interface DownsellOption {
  id: number;
  downsell_id: number;
  label: string;
  price_cents: number;
  active: boolean;
  sort_order: number;
  media_url?: string | null;
  media_type?: string | null;
  created_at?: string;
  updated_at?: string;
}
