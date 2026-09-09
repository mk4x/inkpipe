// Image preparation, shared by the corpus harness and the production agent.
//
// ADR 0001 finding 3 made this a required pipeline stage rather than a setting:
// a full resolution page is roughly 4200 image tokens and hard-fails the
// default 4096 context, and on the rotated, shadowed page A prep moved CER from
// 1.227 to 0.567. Contrast normalisation is what removes the shadow band.

import sharp from 'sharp';

export interface PrepOptions {
  /** Degrees clockwise. Page A of the corpus needs 270. */
  rotate?: number;
  maxEdge?: number;
}

/** Make a page as legible as possible for a vision model. */
export async function prepForModel(
  input: string | Uint8Array,
  { rotate = 0, maxEdge = 1600 }: PrepOptions = {},
): Promise<Uint8Array> {
  const buffer = await sharp(input)
    .rotate(rotate)
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .normalise()
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/**
 * The compressed reference copy committed next to the note (decision 24).
 *
 * Measured at roughly 257 KB for a corpus page, against a stated target of
 * about 200 KB. The owner chose to keep quality 80 rather than tighten it.
 */
export async function prepForVault(
  input: string | Uint8Array,
  { rotate = 0 }: PrepOptions = {},
): Promise<Uint8Array> {
  const buffer = await sharp(input)
    .rotate(rotate)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .webp({ quality: 80 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/** Crop a region, used to embed a diagram that could not be transcribed
 *  (decision 8: the crop is correct by construction). */
export async function cropRegion(
  input: string | Uint8Array,
  region: { left: number; top: number; width: number; height: number },
  { rotate = 0 }: PrepOptions = {},
): Promise<Uint8Array> {
  const buffer = await sharp(input).rotate(rotate).extract(region).webp({ quality: 82 }).toBuffer();
  return new Uint8Array(buffer);
}
