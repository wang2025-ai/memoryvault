import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromFile, htmlToText, normalizeJsonText } from '../src/extract.js';

function minimalPdf(text: string): Buffer {
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('htmlToText', () => {
  it('strips tags, scripts and styles', () => {
    const html = `<html><head><style>body { color: red }</style></head>
      <body><script>evil()</script><h1>Title</h1><p>Hello&nbsp;<b>world</b></p><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Hello world');
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('<');
  });

  it('decodes common entities', () => {
    expect(htmlToText('<p>A &amp; B &lt;tag&gt; &quot;quoted&quot;</p>')).toBe('A & B <tag> "quoted"');
  });
});

describe('normalizeJsonText', () => {
  it('pretty-prints valid JSON', () => {
    expect(normalizeJsonText('{"a":1}')).toBe('{\n "a": 1\n}');
  });

  it('returns the original text for invalid JSON', () => {
    expect(normalizeJsonText('not json {')).toBe('not json {');
  });
});

describe('extractFromFile', () => {
  it('extracts text from a PDF file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvault-extract-'));
    try {
      const file = join(dir, 'sample.pdf');
      writeFileSync(file, minimalPdf('MemoryVault PDF ingestion works'));
      const { text, kind } = await extractFromFile(file);
      expect(kind).toBe('pdf');
      expect(text).toContain('MemoryVault PDF ingestion works');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts html files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvault-extract-'));
    try {
      const file = join(dir, 'page.html');
      writeFileSync(file, '<html><body><h1>Page</h1><p>body text here</p></body></html>');
      const { text, kind } = await extractFromFile(file);
      expect(kind).toBe('html');
      expect(text).toContain('Page');
      expect(text).toContain('body text here');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads plain text files as-is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvault-extract-'));
    try {
      const file = join(dir, 'plain.md');
      writeFileSync(file, '# Just markdown\n\nplain text');
      const { text, kind } = await extractFromFile(file);
      expect(kind).toBe('text');
      expect(text).toContain('# Just markdown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
