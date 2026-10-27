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
    expect(chunks[0]).toContain('para one');
    expect(chunks[0]).toContain('para three');
  });

  it('splits when the target size is exceeded', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `paragraph ${i} ${'x'.repeat(300)}`);
    const chunks = chunkText(paragraphs.join('\n\n'), 900, 1400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1400);
  });

  it('hard-splits a single over-long paragraph', () => {
    const text = 'y'.repeat(3000);
    const chunks = chunkText(text, 900, 1400);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 1400)).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const chunks = chunkText('first\r\n\r\nsecond\r\n\r\nthird', 900, 1400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('first');
    expect(chunks[0]).toContain('third');
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
