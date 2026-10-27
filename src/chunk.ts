export function extractTitle(text: string, fallback: string): string {
  const match = text.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim().slice(0, 200);
  return fallback.slice(0, 200);
}

/**
 * Split text into chunks by merging paragraphs up to `target` characters.
 * Very long paragraphs are hard-split at `max` so no chunk exceeds it.
 */
export function chunkText(text: string, target = 900, max = 1400): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) chunks.push(buffer);
    buffer = '';
  };
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length > max) {
      flush();
      for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
      continue;
    }
    if (buffer && buffer.length + p.length + 2 > target) flush();
    buffer = buffer ? `${buffer}\n\n${p}` : p;
  }
  flush();
  return chunks;
}
