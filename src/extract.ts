import { readFileSync } from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';

export type ExtractKind = 'text' | 'pdf' | 'html';

export interface Extracted {
  text: string;
  kind: ExtractKind;
}

export async function pdfToText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|header|footer|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

export function normalizeJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 1);
  } catch {
    return text;
  }
}

export async function extractFromFile(path: string): Promise<Extracted> {
  const lower = path.toLowerCase();
  const buffer = readFileSync(path);
  if (lower.endsWith('.pdf')) {
    return { text: await pdfToText(buffer), kind: 'pdf' };
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { text: htmlToText(buffer.toString('utf8')), kind: 'html' };
  }
  return { text: buffer.toString('utf8'), kind: 'text' };
}
