export interface TextChunk {
  content: string;
  /** 1-based line number of the first line of this chunk in the source text */
  startLine: number;
}

export function extractTitle(text: string, fallback: string): string {
  const match = text.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim().slice(0, 200);
  return fallback.slice(0, 200);
}

/**
 * Split text into chunks by merging paragraphs up to `target` characters.
 * Very long paragraphs are hard-split at `max` so no chunk exceeds it.
 * Each chunk carries the 1-based line number where it starts.
 */
export function chunkText(text: string, target = 900, max = 1400): TextChunk[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const paragraphs: Array<{ text: string; startLine: number }> = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  const flushParagraph = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join('\n').trim();
    if (joined) paragraphs.push({ text: joined, startLine: bufferStart });
    buffer = [];
  };
  lines.forEach((line, idx) => {
    if (line.trim() === '') {
      flushParagraph();
      return;
    }
    if (buffer.length === 0) bufferStart = idx + 1;
    buffer.push(line);
  });
  flushParagraph();

  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentStart = 0;
  let currentLength = 0;
  const pushChunk = (): void => {
    if (current.length === 0) return;
    chunks.push({ content: current.join('\n\n'), startLine: currentStart });
    current = [];
    currentLength = 0;
  };
  for (const paragraph of paragraphs) {
    if (paragraph.text.length > max) {
      pushChunk();
      for (let i = 0; i < paragraph.text.length; i += max) {
        chunks.push({ content: paragraph.text.slice(i, i + max), startLine: paragraph.startLine });
      }
      continue;
    }
    if (current.length > 0 && currentLength + paragraph.text.length + 2 > target) pushChunk();
    if (current.length === 0) currentStart = paragraph.startLine;
    current.push(paragraph.text);
    currentLength += paragraph.text.length + 2;
  }
  pushChunk();
  return chunks;
}
