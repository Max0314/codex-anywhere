import { safeDownloadName } from './file-utils';

/** Inspect the original bytes, rather than treating a preview or filename as the image. */
export async function imageFileFromDownload(blob: Blob, name: string): Promise<File> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const kind = starts(137, 80, 78, 71, 13, 10, 26, 10) ? ['image/png', 'png']
    : starts(255, 216, 255) ? ['image/jpeg', 'jpg']
      : starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80
        ? ['image/webp', 'webp'] : null;
  if (!kind) throw new Error('image_save_format_not_supported');
  const safeName = safeDownloadName(name);
  const stem = safeName.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${stem}.${kind[1]}`, { type: kind[0] });
}

type ImageShareNavigator = Partial<Pick<Navigator, 'canShare' | 'share'>>;

export function canShareImage(file: File, target: ImageShareNavigator = navigator): boolean {
  try { return Boolean(target.share && target.canShare?.({ files: [file] })); }
  catch { return false; }
}

/** Called directly from a click: never await transfer or image decoding before share(). */
export async function shareImage(file: File, target: ImageShareNavigator = navigator) {
  if (!canShareImage(file, target)) return 'unavailable';
  try {
    await target.share!({ files: [file] });
    return 'shared'; // The OS does not tell us which destination the user chose.
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
