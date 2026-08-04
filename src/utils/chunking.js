/**
 * Splits long text into overlapping chunks for embedding, instead of the old approach of
 * silently truncating anything past ~8000 characters (losing everything after that point to
 * vector search entirely). Small records that already fit in one chunk are returned unchanged —
 * chunking only kicks in once text actually exceeds the target chunk size.
 *
 * No tokenizer dependency: token counts are approximated at ~4 chars/token (a standard rule of
 * thumb for English text), which is precise enough for sizing embedding chunks and avoids pulling
 * in a real tokenizer for a use case that doesn't need exact counts.
 */
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHUNK_CHARS = 850 * CHARS_PER_TOKEN; // ~850 tokens, within the requested 700-1000
const DEFAULT_OVERLAP_CHARS = 125 * CHARS_PER_TOKEN; // ~125 tokens, within the requested 100-150

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

export function needsChunking(text, chunkChars = DEFAULT_CHUNK_CHARS) {
  return String(text || '').trim().length > chunkChars;
}

/** Paragraphs first; any paragraph still too long gets split into sentences. Never splits mid-word. */
// ASCII .!? plus Devanagari sentence-enders (। U+0964, ॥ U+0965) — real ingested content
// includes Hindi meeting transcripts, which almost never use ASCII periods to end a sentence.
const SENTENCE_END_RE = /(?<=[.!?।॥])\s+/;

function splitIntoUnits(text, chunkChars) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const para of paragraphs) {
    if (para.length <= chunkChars) {
      units.push(para);
      continue;
    }
    // split() (unlike match()) partitions the WHOLE string — every character ends up in some
    // piece, even runs with no recognized terminator at all (those just come back as one piece,
    // handled by the hard-split fallback in chunkText). match() with a global flag was tried
    // first and silently DROPPED every substring that didn't match — verified live on a real
    // Hindi transcript: it kept only ~20% of the document (fragments near timestamp decimals)
    // and discarded the rest before chunking ever saw it.
    const sentences = para.split(SENTENCE_END_RE).map((s) => s.trim()).filter(Boolean);
    units.push(...(sentences.length ? sentences : [para]));
  }
  return units.length ? units : [text];
}

/** Back up from the end of `text` by ~overlapChars, snapped to the nearest preceding space. */
function tailOverlap(text, overlapChars) {
  if (text.length <= overlapChars) return text;
  let start = text.length - overlapChars;
  while (start < text.length && text[start] !== ' ') start++;
  return text.slice(start).trim();
}

/**
 * @returns {string[]} chunks in original order; for short text, a single-element array containing
 *   the whole (trimmed) text unchanged — callers should treat that as "not chunked".
 */
export function chunkText(text, { chunkChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = {}) {
  const full = String(text || '').trim();
  if (!full) return [];
  if (full.length <= chunkChars) return [full];

  const units = splitIntoUnits(full, chunkChars);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (!current.trim()) return;
    // Fallback for a single unit still longer than the chunk target (e.g. one huge unbroken
    // line with no sentence punctuation) — hard-split by character as a last resort.
    let rest = current;
    while (rest.length > chunkChars * 1.5) {
      chunks.push(rest.slice(0, chunkChars));
      rest = tailOverlap(rest.slice(0, chunkChars), overlapChars) + rest.slice(chunkChars);
    }
    chunks.push(rest);
  };

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length > chunkChars && current) {
      flush();
      const overlap = tailOverlap(current, overlapChars);
      current = overlap ? `${overlap}\n\n${unit}` : unit;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks;
}
