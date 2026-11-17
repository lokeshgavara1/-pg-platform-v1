import type { ApiClient } from './api';

export type UploadPurpose = 'KYC_ID' | 'KYC_PHOTO' | 'COMPLAINT_PHOTO' | 'DEDUCTION_PHOTO';

const MAX_BYTES = 5 * 1024 * 1024;

/** Resize/compress photos in the browser before upload (max 1600px, JPEG ~80%). PDFs pass through. */
export async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return blob && blob.size < file.size ? blob : file;
}

/** Upload through a signed URL; returns the new file id. */
export async function uploadFile(client: ApiClient, purpose: UploadPurpose, file: File): Promise<string> {
  const body = await compressImage(file);
  const mimeType = body.type || file.type;
  if (body.size > MAX_BYTES) throw new Error('File is larger than 5 MB even after compression');
  const { fileId, url } = await client.post<{ fileId: string; url: string }>('/api/files/upload-url', { purpose, mimeType, sizeBytes: body.size });
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': mimeType }, body });
  if (!res.ok) {
    let msg = 'Upload failed';
    try {
      msg = (await res.json()).error?.message ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return fileId;
}

/** Open a private file through a short-lived signed URL in a new tab. */
export async function openFile(client: ApiClient, fileId: string) {
  const win = window.open('', '_blank');
  const { url } = await client.get<{ url: string }>(`/api/files/${fileId}/view-url`);
  if (win) win.location.href = url;
  else window.location.href = url;
}

/** Open a PDF/CSV that needs auth headers (receipts, exports). */
export async function openBlob(client: ApiClient, method: 'GET' | 'POST', path: string, body?: unknown, download?: string) {
  const blob = await client.blob(method, path, body);
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = download;
    a.click();
  } else {
    window.open(url, '_blank');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
