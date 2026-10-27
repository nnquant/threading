import type { Api } from './bridge';
import type { ImageRef } from './types';

/** Markdown refers to saved images as `![alt](attachment:<id>)`. */
export const ATTACHMENT = 'attachment:';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/** Recognises an image by its first bytes, the same way the backend does. */
export function sniffImage(bytes: Uint8Array): { ext: string; mime: ImageRef['mime'] } | null {
  const starts = (...sig: number[]) => sig.every((byte, at) => bytes[at] === byte);
  const ascii = (from: number, text: string) => [...text].every((char, at) => bytes[from + at] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('图片数据无法读取。'));
    reader.readAsDataURL(file);
  });
}

export const isImageFile = (file: File) => /^image\/(png|jpeg|gif|webp)$/.test(file.type);

// Saved images never change, so one blob URL per id serves the whole session.
const urls = new Map<string, Promise<string>>();
/** A URL an <img> can show: saved images become blob URLs, anything else passes through. */
export function imageUrl(api: Api, src: string): Promise<string> {
  if (!src.startsWith(ATTACHMENT)) return Promise.resolve(src);
  const id = src.slice(ATTACHMENT.length);
  let url = urls.get(id);
  if (!url) {
    url = api.readImage(id).then(bytes => URL.createObjectURL(new Blob([bytes])));
    url.catch(() => urls.delete(id));
    urls.set(id, url);
  }
  return url;
}
