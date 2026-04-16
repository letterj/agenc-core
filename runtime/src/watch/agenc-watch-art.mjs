/**
 * Terminal ANSI art renderer for the TUI side panel.
 *
 * Port of the reference Python script at `/home/tetsuo/git/ansi-art`
 * (the 70-char "standard" ramp + luminance → char lookup + 24-bit
 * foreground color per cell). Loads the source image once via jimp,
 * caches the decoded RGB buffer, re-rasterizes on terminal resize.
 */

import { readFileSync } from "node:fs";
import { Jimp, ResizeStrategy } from "jimp";

// Same ramp as ansi_art.py "standard" — darkest → brightest.
const STANDARD_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const RAMPS = {
  standard: STANDARD_RAMP,
  blocks: " \u2591\u2592\u2593\u2588",
  simple: " .:-=+*#%@",
  binary: " @",
};

// Terminal cells are roughly twice as tall as they are wide; the
// renderer compresses vertical sampling to compensate. Matches the
// Python script's default `--char-aspect 0.5`.
const DEFAULT_CHAR_ASPECT = 0.5;

const ANSI_RESET = "\x1b[0m";
function fg24(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function pickChar(ramp, luminance01, invert) {
  let lum = invert ? 1 - luminance01 : luminance01;
  if (lum < 0) lum = 0;
  if (lum > 1) lum = 1;
  const idx = Math.min(ramp.length - 1, Math.floor(lum * (ramp.length - 1)));
  return ramp[idx];
}

function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function validateRamp(ramp) {
  if (typeof ramp !== "string" || ramp.length < 2) return STANDARD_RAMP;
  return ramp;
}

/**
 * Build an art renderer for a single source image. The returned
 * renderer caches the decoded image; call `.render({cols, rows, …})`
 * repeatedly on resize without re-decoding.
 *
 * Returns `null` when the image cannot be read (file missing /
 * corrupt). Callers should treat null as "disable the art panel" and
 * not fall into a render loop.
 */
export async function createAnsiArtRenderer({ imagePath, ramp, invert } = {}) {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    return null;
  }
  let decoded;
  try {
    const buf = readFileSync(imagePath);
    decoded = await Jimp.read(buf);
  } catch {
    return null;
  }
  const sourceWidth = decoded.bitmap.width;
  const sourceHeight = decoded.bitmap.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const rampString = validateRamp(
    typeof ramp === "string" ? RAMPS[ramp] ?? ramp : undefined,
  );
  const invertFlag = invert === true;

  // Cache the last rasterization keyed by (cols, rows, charAspect) so
  // the frame renderer can call render() every tick without repeating
  // the resize/quantize work unless the terminal actually resized.
  let cacheKey = null;
  let cacheRows = null;

  async function render({ cols, rows, charAspect = DEFAULT_CHAR_ASPECT } = {}) {
    const targetCols = Math.max(1, Math.floor(Number(cols)));
    const targetRows = Math.max(1, Math.floor(Number(rows)));
    const targetAspect = Number.isFinite(Number(charAspect))
      ? Math.max(0.1, Number(charAspect))
      : DEFAULT_CHAR_ASPECT;
    const key = `${targetCols}:${targetRows}:${targetAspect}`;
    if (key === cacheKey && cacheRows !== null) return cacheRows;

    // Fit-to-strip: compute the ideal source aspect (h/w in source
    // pixels) that would produce exactly `targetRows × targetCols`
    // output cells without distortion, then center-crop the source
    // to that aspect. A landscape image like aura.jpeg (1280×720)
    // gets its sides cropped to a portrait region so the strip fills
    // end-to-end — same look as a naturally-square image like
    // girl.jpeg.
    const desiredSourceAspect =
      targetRows / Math.max(1, targetCols * targetAspect);
    const actualSourceAspect = sourceHeight / sourceWidth;
    let cropX = 0;
    let cropY = 0;
    let cropW = sourceWidth;
    let cropH = sourceHeight;
    if (actualSourceAspect > desiredSourceAspect) {
      // Source is taller than the strip wants — keep full width,
      // crop top/bottom symmetrically.
      cropH = Math.max(1, Math.round(sourceWidth * desiredSourceAspect));
      cropY = Math.max(0, Math.floor((sourceHeight - cropH) / 2));
    } else if (actualSourceAspect < desiredSourceAspect) {
      // Source is wider than the strip wants — keep full height,
      // crop sides symmetrically.
      cropW = Math.max(1, Math.round(sourceHeight / desiredSourceAspect));
      cropX = Math.max(0, Math.floor((sourceWidth - cropW) / 2));
    }

    const renderRows = targetRows;

    // Quality pass:
    //  1. `contrast(+0.15)` boosts mid-tone separation so the ramp
    //     isn't dominated by dark chars in low-light regions.
    //  2. Supersample the cropped region to 2× the target dims with
    //     BICUBIC, then average each 2×2 block down to the final
    //     cell. Gives proper area sampling (vs BILINEAR's
    //     nearest-neighbor grab when the source is much larger than
    //     the cell grid).
    const superCols = targetCols * 2;
    const superRows = renderRows * 2;
    const clone = decoded.clone();
    if (cropX !== 0 || cropY !== 0 || cropW !== sourceWidth || cropH !== sourceHeight) {
      clone.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
    }
    clone.contrast(0.15);
    clone.resize({
      w: superCols,
      h: superRows,
      mode: ResizeStrategy.BICUBIC,
    });
    const { width: imgW, height: imgH, data } = clone.bitmap;
    const out = [];
    for (let y = 0; y < renderRows; y += 1) {
      let row = "";
      let lastColor = "";
      for (let x = 0; x < targetCols; x += 1) {
        // Average the 2×2 super-block covering this terminal cell.
        const sx = x * 2;
        const sy = y * 2;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;
        for (let dy = 0; dy < 2 && sy + dy < imgH; dy += 1) {
          for (let dx = 0; dx < 2 && sx + dx < imgW; dx += 1) {
            const offset = ((sy + dy) * imgW + (sx + dx)) * 4;
            rSum += data[offset];
            gSum += data[offset + 1];
            bSum += data[offset + 2];
            count += 1;
          }
        }
        const r = count > 0 ? Math.round(rSum / count) : 0;
        const g = count > 0 ? Math.round(gSum / count) : 0;
        const b = count > 0 ? Math.round(bSum / count) : 0;
        const lum = luminance(r, g, b);
        const ch = pickChar(rampString, lum, invertFlag);
        const color = fg24(r, g, b);
        if (color !== lastColor) {
          row += color;
          lastColor = color;
        }
        row += ch;
      }
      out.push(row + ANSI_RESET);
    }
    // Pad vertically with empty rows so callers can blit one row per
    // terminal line without length-mismatch bookkeeping.
    while (out.length < targetRows) {
      out.push("");
    }
    cacheKey = key;
    cacheRows = out;
    return out;
  }

  function invalidate() {
    cacheKey = null;
    cacheRows = null;
  }

  return {
    render,
    invalidate,
    sourceWidth,
    sourceHeight,
    rampLength: rampString.length,
  };
}
