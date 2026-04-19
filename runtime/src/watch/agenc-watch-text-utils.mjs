/**
 * Text sanitization, formatting, and truncation utilities for the watch TUI.
 *
 * Pure functions — no watch state or side-effect dependencies.
 */

export function sanitizeLargeText(value) {
  return String(value)
    .replace(
      /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
      "(image omitted)",
    )
    .replace(/"data":"[A-Za-z0-9+/=\r\n]{120,}"/g, '"data":"(image omitted)"')
    .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(blob omitted)");
}

export function sanitizeInlineText(value) {
  // Strip ANSI / OSC / DCS and control chars before whitespace-collapse.
  // Previously this function fed model-emitted ANSI straight into the
  // status line, splash, and footer, where the raw SGR bytes rendered
  // as garbled control-character cells instead of text.
  return stripTerminalControlSequences(sanitizeLargeText(value))
    .replace(/\s+/g, " ")
    .trim();
}

export function stripTerminalControlSequences(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

export function stripMarkdownDecorators(value) {
  return stripTerminalControlSequences(String(value ?? ""))
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");
}

export function sanitizeDisplayText(value) {
  return stripMarkdownDecorators(sanitizeLargeText(value));
}

export function stable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function tryPrettyJson(value) {
  const raw = typeof value === "string" ? sanitizeLargeText(value) : stable(value);
  if (typeof raw !== "string") {
    return stable(raw);
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    const parts = raw.split("\n");
    if (parts.length > 1) {
      return parts
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return "";
          try {
            return JSON.stringify(JSON.parse(trimmed), null, 2);
          } catch {
            return trimmed;
          }
        })
        .join("\n");
    }
    return raw;
  }
}

export function tryParseJson(value) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? value : null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function truncate(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}\u2026`;
}

export function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: numeric >= 10_000 ? 0 : 1,
  }).format(numeric);
}

export function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatClockLabel(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "--:--:--";
  }
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Minimal East Asian Width / zero-width lookup. Returns the number of
// terminal columns a single code point consumes. Previously every
// helper below assumed 1 codepoint = 1 column, so combining
// diacritics (should be 0), CJK (should be 2), emoji (should be 2),
// and VS16 (should be 0) all misaligned the column math.
//
// The ranges below cover the common cases an agent TUI actually sees:
// combining marks, zero-width joiners/non-joiners, variation
// selectors, CJK blocks, Hangul, halfwidth/fullwidth forms, and the
// main emoji pictograph / symbol planes. Not a full East Asian Width
// implementation — just enough to stop breaking alignment for the
// code paths `visibleLength`, `truncateAnsi`, `fitAnsi`, `padAnsi`,
// and `wrapLine` feed.
function codePointColumnWidth(codePoint) {
  if (codePoint < 0x20) return 0;
  // Combining diacritical marks
  if (codePoint >= 0x0300 && codePoint <= 0x036F) return 0;
  // Variation selectors (VS1-16, VS17-256), ZWNJ/ZWJ/ZW space, LTR/RTL marks
  if (codePoint >= 0x200B && codePoint <= 0x200F) return 0;
  if (codePoint >= 0x202A && codePoint <= 0x202E) return 0;
  if (codePoint >= 0x2060 && codePoint <= 0x2064) return 0;
  if (codePoint === 0xFEFF) return 0;
  if (codePoint >= 0xFE00 && codePoint <= 0xFE0F) return 0;
  if (codePoint >= 0xE0100 && codePoint <= 0xE01EF) return 0;
  // Wide: Hangul Jamo
  if (codePoint >= 0x1100 && codePoint <= 0x115F) return 2;
  // Wide: CJK + Hiragana + Katakana + etc.
  if (codePoint >= 0x2E80 && codePoint <= 0x303E) return 2;
  if (codePoint >= 0x3041 && codePoint <= 0x33FF) return 2;
  if (codePoint >= 0x3400 && codePoint <= 0x4DBF) return 2;
  if (codePoint >= 0x4E00 && codePoint <= 0x9FFF) return 2;
  if (codePoint >= 0xA000 && codePoint <= 0xA4CF) return 2;
  if (codePoint >= 0xAC00 && codePoint <= 0xD7A3) return 2;
  if (codePoint >= 0xF900 && codePoint <= 0xFAFF) return 2;
  if (codePoint >= 0xFE30 && codePoint <= 0xFE4F) return 2;
  if (codePoint >= 0xFF00 && codePoint <= 0xFF60) return 2;
  if (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) return 2;
  // Emoji pictograph / symbol planes (approximate; covers U+1F300–1FAFF)
  if (codePoint >= 0x1F300 && codePoint <= 0x1FAFF) return 2;
  return 1;
}

// Walk the string by code point. Returns { width, units } so callers
// can step a matching number of JS string units forward when they
// consumed `width` cells. `units` is 2 for any astral code point
// (which is a UTF-16 surrogate pair).
function nextCodePointCell(text, index) {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return { codePoint: 0, width: 0, units: 0 };
  const units = codePoint > 0xFFFF ? 2 : 1;
  return { codePoint, width: codePointColumnWidth(codePoint), units };
}

export function visibleLength(text) {
  const source = String(text ?? "");
  let index = 0;
  let width = 0;
  while (index < source.length) {
    if (source[index] === "\x1b") {
      const sgr = source.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (sgr) {
        index += sgr[0].length;
        continue;
      }
      const osc = source.slice(index).match(/^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        index += osc[0].length;
        continue;
      }
    }
    const cell = nextCodePointCell(source, index);
    if (cell.units === 0) break;
    width += cell.width;
    index += cell.units;
  }
  return width;
}

export function truncateAnsi(text, maxChars, resetCode = "\x1b[0m") {
  const source = String(text ?? "");
  if (visibleLength(source) <= maxChars) {
    return source;
  }
  const target = Math.max(0, maxChars - 1);
  let index = 0;
  let visible = 0;
  let output = "";
  while (index < source.length) {
    if (source[index] === "\x1b") {
      const sgr = source.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (sgr) {
        output += sgr[0];
        index += sgr[0].length;
        continue;
      }
      const osc = source.slice(index).match(/^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        output += osc[0];
        index += osc[0].length;
        continue;
      }
    }
    const cell = nextCodePointCell(source, index);
    if (cell.units === 0) break;
    if (visible + cell.width > target) {
      output += "\u2026";
      break;
    }
    output += source.slice(index, index + cell.units);
    visible += cell.width;
    index += cell.units;
  }
  return `${output}${resetCode}`;
}

export function fitAnsi(text, width) {
  return visibleLength(text) > width ? truncateAnsi(text, width) : text;
}

export function padAnsi(text, width) {
  const fitted = fitAnsi(text, width);
  const needed = Math.max(0, width - visibleLength(fitted));
  return `${fitted}${" ".repeat(needed)}`;
}

// Slice `text` at its nearest "safe" point below `maxWidth` terminal
// columns, preserving ANSI escape boundaries. Returns
// { head, rest, visibleWidth, lastSpaceVisibleWidth } so `wrapLine`
// can decide whether a word-boundary split is preferable.
function sliceAtVisibleWidth(text, maxWidth) {
  const source = String(text ?? "");
  let index = 0;
  let visible = 0;
  let lastSpaceIndex = -1;
  let lastSpaceVisibleWidth = -1;
  while (index < source.length && visible < maxWidth) {
    if (source[index] === "\x1b") {
      const sgr = source.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (sgr) {
        index += sgr[0].length;
        continue;
      }
      const osc = source.slice(index).match(/^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        index += osc[0].length;
        continue;
      }
    }
    const cell = nextCodePointCell(source, index);
    if (cell.units === 0) break;
    if (visible + cell.width > maxWidth) break;
    if (source[index] === " ") {
      lastSpaceIndex = index;
      lastSpaceVisibleWidth = visible;
    }
    visible += cell.width;
    index += cell.units;
  }
  return {
    head: source.slice(0, index),
    rest: source.slice(index),
    visibleWidth: visible,
    lastSpaceIndex,
    lastSpaceVisibleWidth,
  };
}

export function wrapLine(line, width) {
  const source = String(line ?? "");
  if (visibleLength(source) <= width) {
    return [source];
  }
  const lines = [];
  let remaining = source;
  while (visibleLength(remaining) > width) {
    const sliced = sliceAtVisibleWidth(remaining, width);
    // Prefer a word-boundary split when the last space landed past
    // 45% of the line width — otherwise mid-word is visually
    // smoother than a very short left chunk.
    if (
      sliced.lastSpaceIndex > 0 &&
      sliced.lastSpaceVisibleWidth >= Math.floor(width * 0.45)
    ) {
      lines.push(remaining.slice(0, sliced.lastSpaceIndex));
      remaining = remaining.slice(sliced.lastSpaceIndex + 1);
      continue;
    }
    lines.push(sliced.head);
    // `sliced.rest` begins at a safe boundary — either the next code
    // point, past an escape, or after a wide glyph that would have
    // overflowed. No leading-whitespace trim needed because we did
    // not break inside a word.
    remaining = sliced.rest;
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines;
}

export function wrapBlock(text, width) {
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
}

export function parseStructuredJson(value) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? [value] : [];
  }
  const single = tryParseJson(value);
  if (single && typeof single === "object" && !Array.isArray(single)) {
    return [single];
  }
  return value
    .split("\n")
    .map((line) => tryParseJson(line.trim()))
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}
