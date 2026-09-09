// Image preparation, shared by the spike and (later) the real pipeline.
//
// Two jobs that are easy to conflate but are not the same thing:
//
//   prepForModel  : make the page as legible as possible for a vision model.
//                   Downscale hard, because every model resizes internally
//                   anyway and feeding 3072x4096 just means the model does the
//                   downscale with no knowledge of what matters.
//   prepForVault  : make the reference copy that lands next to the note, per
//                   decision 24 in PREPARATION.md. Roughly 200 KB, greyscale,
//                   1600px long edge, WebP q80.

import sharp from 'sharp';

/** Rotate so the page reads upright. Page A was shot 90 degrees off. */
export async function prepForModel(inputPath, { rotate = 0, maxEdge = 1600 } = {}) {
  return sharp(inputPath)
    .rotate(rotate)               // explicit, not EXIF: the EXIF tag is absent here
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .normalise()                  // stretch contrast, which is what fights the shadow band
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The compressed copy that gets committed into the vault alongside the note. */
export async function prepForVault(inputPath, { rotate = 0 } = {}) {
  return sharp(inputPath)
    .rotate(rotate)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .webp({ quality: 80 })
    .toBuffer();
}
