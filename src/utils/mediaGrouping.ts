import { InputMediaPhoto, InputMediaVideo } from 'grammy/types';

export interface MediaAsset {
  id: string;
  kind: 'photo' | 'video' | 'audio';
  source_url: string | null;
  file_id: string | null;
  file_unique_id: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface GroupedMedia {
  albumMedia: (InputMediaPhoto | InputMediaVideo)[];
  audios: MediaAsset[];
}

export function groupMediaForSending(mediaAssets: MediaAsset[]): GroupedMedia {
  const albumMedia: (InputMediaPhoto | InputMediaVideo)[] = [];
  const audios: MediaAsset[] = [];

  for (const asset of mediaAssets) {
    if (asset.kind === 'photo') {
      albumMedia.push({
        type: 'photo',
        media: asset.file_id || asset.source_url || '',
      });
    } else if (asset.kind === 'video') {
      albumMedia.push({
        type: 'video',
        media: asset.file_id || asset.source_url || '',
        width: asset.width || undefined,
        height: asset.height || undefined,
        duration: asset.duration || undefined,
      });
    } else if (asset.kind === 'audio') {
      audios.push(asset);
    }
  }

  return { albumMedia, audios };
}
