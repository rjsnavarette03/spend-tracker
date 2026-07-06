// Turn a user-selected image file into a small, square data URI suitable for
// storing inline on an account. We center-crop to a square, downscale to at
// most MAX_DIM, and re-compress (WebP, falling back to JPEG) until the result
// is comfortably under the API's per-request body cap. The account image is a
// small avatar, so aggressive downscaling is fine and keeps payloads tiny.

const MAX_DIM = 256;
const TARGET_BYTES = 90 * 1024; // aim well under the server's accounts body cap

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    // Read the file as a data: URL rather than a blob: object URL. The app's
    // CSP allows `img-src 'self' data:` but NOT blob:, so an <img> pointed at
    // a blob: URL is blocked on the live (Apache) site. data: is already
    // permitted (the stored avatars are data URIs), so this needs no CSP change.
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** True if this browser's canvas can actually encode WebP (Safari <14 can't). */
function canEncodeWebp(canvas: HTMLCanvasElement): boolean {
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

export async function fileToAccountImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file');
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('Image is too large (max 15MB)');
  }

  const img = await loadImage(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) {
    throw new Error('Could not read that image');
  }

  // Center-crop to a square, then scale that square down to at most MAX_DIM.
  const side = Math.min(srcW, srcH);
  const sx = (srcW - side) / 2;
  const sy = (srcH - side) / 2;
  const dim = Math.min(MAX_DIM, side);

  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, dim, dim);

  const type = canEncodeWebp(canvas) ? 'image/webp' : 'image/jpeg';
  let quality = 0.82;
  let dataUrl = canvas.toDataURL(type, quality);
  while (dataUrl.length > TARGET_BYTES && quality > 0.4) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL(type, quality);
  }
  return dataUrl;
}
