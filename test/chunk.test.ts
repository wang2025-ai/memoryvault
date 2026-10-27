import { describe, expect, it } from 'vitest';
import { chunkText, extractTitle } from '../src/chunk.js';

describe('chunkText', () => {
  it('returns [] for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('merges small paragraphs up to the target size', () => {
    const text = ['para one', '', 'para two', '', 'para three'].join('\n\n');
    const chunks = chunkText(text, 900, 1400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('para one');
    expect(chunks[0].content).toContain('para three');
    expect(chunks[0].startLine).toBe(1);
  });

  it('tracks the start line of each chunk', () => {
    const lines = ['line one', '', 'line three', '', 'line five', 'line six'];
    const chunks = chunkText(lines.join('\n'), 900, 1400);
    // all paragraphs fit into one chunk starting at line 1
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);

    // force a split: big paragraph forces a chunk boundary
    const big = 'a'.repeat(1000);
    const chunks2 = chunkText(`# Title\n\n${big}\n\ntail paragraph`, 900, 1400);
    expect(chunks2.length).toBe(3);
    expect(chunks2[0].startLine).toBe(1); // "# Title"
    expect(chunks2[1].startLine).toBe(3); // the big paragraph
    expect(chunks2[2].content).toBe('tail paragraph');
    expect(chunks2[2].startLine).toBe(5);
  });

  it('splits when the target size is exceeded', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `paragraph ${i} ${'x'.repeat(300)}`);
    const chunks = chunkText(paragraphs.join('\n\n'), 900, 1400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1400);
  });

  it('hard-splits a single over-long paragraph', () => {
    const text = 'y'.repeat(3000);
    const chunks = chunkText(text, 900, 1400);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.content.length <= 1400)).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const chunks = chunkText('first\r\n\r\nsecond\r\n\r\nthird', 900, 1400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('first');
    expect(chunks[0].content).toContain('third');
  });

  it('skips leading blank lines when counting start lines', () => {
    const chunks = chunkText('\n\n\nlate start\n\nmore', 900, 1400);
    expect(chunks[0].startLine).toBe(4);
  });
});

describe('extractTitle', () => {
  it('uses the first markdown heading', () => {
    expect(extractTitle('# My Title\n\nbody', 'fallback.txt')).toBe('My Title');
    expect(extractTitle('intro\n\n# Later Heading\n\nbody', 'fallback.txt')).toBe('Later Heading');
  });

  it('falls back to the given name', () => {
    expect(extractTitle('no headings here', 'notes.md')).toBe('notes.md');
  });
});
