// Text normalization shared by user-facing search results.
// Simulator runs replay the same caption many times; collapse those to one row.

// Lowercase, punctuation to spaces, collapse whitespace: the key used to detect duplicates.
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep the first (highest-ranked) item per normalized text. Accepts rows ({text}) or strings.
function dedupeByText(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = typeof item === 'string' ? item : item && item.text;
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

module.exports = { normalizeText, dedupeByText };
