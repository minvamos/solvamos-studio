/**
 * Customer-facing local file ingest — no GCP console required.
 * Text → local corpus (chunked for large CSV); PDF raw bytes → Vertex import.
 */
import fs from 'fs';
import { dataFile, ensureDataDir } from './data-paths.js';
import type { LocalRagCorpus, LocalRagDoc } from './drive-ingest.js';

/** Upload file count (UI also caps at 25). */
const MAX_FILES = 25;
/** Max docs after chunking — matches Vertex inline import batch size. */
const MAX_DOCS = 40;
/** Per-file raw text before chunking (was 12_000 — truncated large CSVs). */
const MAX_CHARS_PER_FILE = 500_000;
const MAX_TOTAL_CHARS = 1_500_000;
const MAX_TEXT_BYTES = 2_000_000;
const MAX_PDF_BYTES = 8_000_000;
/** Chunk size for Vertex / Answer retrieval quality. */
const CHUNK_CHARS = 12_000;

export type LocalUploadInput = {
  name: string;
  mimeType?: string;
  /** UTF-8 text already extracted in browser */
  text?: string;
  /** Base64 for PDF (and fallback text decode) */
  contentBase64?: string;
};

function corpusPath(agentId: string) {
  return dataFile(`rag/${agentId}.json`);
}

function isPdf(name: string, mime: string): boolean {
  return mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
}

function looksTexty(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.json') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.log') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml')
  ) {
    return true;
  }
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/markdown' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime === 'application/csv'
  );
}

type Decoded =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'pdf'; base64: string; byteLength: number }
  | { kind: 'skip'; reason: string };

/** Split large text (CSV keeps header on every chunk). */
export function chunkTextForRag(name: string, text: string, chunkSize = CHUNK_CHARS): string[] {
  if (text.length <= chunkSize) return [text];
  const isTabular = /\.(csv|tsv)$/i.test(name);
  let header = '';
  let body = text;
  if (isTabular) {
    const nl = text.indexOf('\n');
    if (nl > 0 && nl < 4000) {
      header = text.slice(0, nl + 1);
      body = text.slice(nl + 1);
    }
  }
  const budget = Math.max(2000, chunkSize - header.length);
  const out: string[] = [];
  let pos = 0;
  while (pos < body.length && out.length < MAX_DOCS) {
    let end = Math.min(pos + budget, body.length);
    if (end < body.length) {
      const nl = body.lastIndexOf('\n', end);
      if (nl > pos + budget * 0.5) end = nl + 1;
    }
    out.push(header + body.slice(pos, end));
    pos = end;
  }
  return out.length ? out : [text.slice(0, chunkSize)];
}

function decodeUpload(file: LocalUploadInput): Decoded {
  const name = (file.name || 'upload').trim() || 'upload';
  const mime = (file.mimeType || 'application/octet-stream').trim();

  if (isPdf(name, mime)) {
    if (!file.contentBase64) {
      return { kind: 'skip', reason: `${name}: PDF requires binary upload (contentBase64)` };
    }
    try {
      const buf = Buffer.from(String(file.contentBase64).replace(/\s/g, ''), 'base64');
      if (buf.length > MAX_PDF_BYTES) {
        return { kind: 'skip', reason: `${name}: PDF too large (>8MB)` };
      }
      if (buf.length < 5) {
        return { kind: 'skip', reason: `${name}: empty PDF` };
      }
      return { kind: 'pdf', base64: buf.toString('base64'), byteLength: buf.length };
    } catch {
      return { kind: 'skip', reason: `${name}: PDF base64 decode failed` };
    }
  }

  if (file.text != null && String(file.text).trim()) {
    const raw = String(file.text);
    const truncated = raw.length > MAX_CHARS_PER_FILE;
    return {
      kind: 'text',
      text: raw.slice(0, MAX_CHARS_PER_FILE),
      truncated,
    };
  }

  if (file.contentBase64) {
    try {
      const buf = Buffer.from(String(file.contentBase64).replace(/\s/g, ''), 'base64');
      if (buf.length > MAX_TEXT_BYTES) {
        return { kind: 'skip', reason: `${name}: file too large (>2MB)` };
      }
      if (!looksTexty(name, mime)) {
        return {
          kind: 'skip',
          reason: `${name}: unsupported type (use txt/md/json/csv/html/pdf)`,
        };
      }
      const text = buf.toString('utf8');
      if (!text.trim()) return { kind: 'skip', reason: `${name}: empty` };
      const truncated = text.length > MAX_CHARS_PER_FILE;
      return {
        kind: 'text',
        text: text.slice(0, MAX_CHARS_PER_FILE),
        truncated,
      };
    } catch {
      return { kind: 'skip', reason: `${name}: base64 decode failed` };
    }
  }

  return { kind: 'skip', reason: `${name}: no content` };
}

async function mirrorToPrisma(agentId: string, docs: LocalRagDoc[]) {
  if (!process.env.DATABASE_URL) return;
  try {
    const { prisma } = await import('./db.js');
    for (const d of docs) {
      // Never store PDF base64 in SQL — stub text only
      await prisma.ragDocument.upsert({
        where: {
          agentId_driveFileId: { agentId, driveFileId: d.id },
        },
        create: {
          agentId,
          driveFileId: d.id,
          name: d.name,
          mimeType: d.mimeType,
          text: d.text,
          webViewLink: d.webViewLink || null,
        },
        update: {
          name: d.name,
          mimeType: d.mimeType,
          text: d.text,
          webViewLink: d.webViewLink || null,
        },
      });
    }
  } catch (err: any) {
    console.warn('[local-ingest] prisma mirror skipped', err?.message || err);
  }
}

export async function ingestLocalUploadsForAgent(opts: {
  agentId: string;
  files: LocalUploadInput[];
  /** When true, append to existing corpus instead of replacing */
  append?: boolean;
}): Promise<LocalRagCorpus & { skipped: string[] }> {
  const files = Array.isArray(opts.files) ? opts.files.slice(0, MAX_FILES) : [];
  const docs: LocalRagDoc[] = [];
  const skipped: string[] = [];
  let totalChars = 0;

  if (opts.append) {
    try {
      const existing = JSON.parse(
        fs.readFileSync(corpusPath(opts.agentId), 'utf8')
      ) as LocalRagCorpus;
      if (existing?.docs?.length) {
        docs.push(...existing.docs);
        totalChars = docs.reduce((n, d) => n + (d.text?.length || 0), 0);
      }
    } catch {
      /* fresh */
    }
  }

  for (let i = 0; i < files.length; i++) {
    if (docs.length >= MAX_DOCS) {
      skipped.push('document limit reached (max chunks)');
      break;
    }
    const f = files[i];
    const decoded = decodeUpload(f);
    if (decoded.kind === 'skip') {
      skipped.push(decoded.reason);
      continue;
    }

    const baseId = `local-${Date.now().toString(36)}-${i}-${(f.name || 'f')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 40)}`;
    const baseName = (f.name || `file-${i + 1}`).slice(0, 200);

    if (decoded.kind === 'pdf') {
      docs.push({
        id: baseId,
        name: baseName.endsWith('.pdf') ? baseName : `${baseName}.pdf`,
        mimeType: 'application/pdf',
        text: `[PDF ${Math.round(decoded.byteLength / 1024)}KB — indexed by AI Applications] ${f.name || ''}`,
        contentBase64: decoded.base64,
      });
      continue;
    }

    if (decoded.truncated) {
      skipped.push(
        `${baseName}: truncated to ${MAX_CHARS_PER_FILE.toLocaleString()} chars (file was larger)`
      );
    }

    const chunks = chunkTextForRag(baseName, decoded.text);
    for (let c = 0; c < chunks.length; c++) {
      if (docs.length >= MAX_DOCS) {
        skipped.push(`${baseName}: remaining chunks dropped (max ${MAX_DOCS} docs)`);
        break;
      }
      if (totalChars >= MAX_TOTAL_CHARS) {
        skipped.push('text char limit reached');
        break;
      }
      const piece = chunks[c];
      const name =
        chunks.length > 1 ? `${baseName} (part ${c + 1}/${chunks.length})` : baseName;
      docs.push({
        id: chunks.length > 1 ? `${baseId}-p${c + 1}` : baseId,
        name: name.slice(0, 200),
        mimeType: f.mimeType || 'text/plain',
        text: piece,
      });
      totalChars += piece.length;
    }
  }

  const corpus: LocalRagCorpus = {
    agentId: opts.agentId,
    driveSourceId: 'local_upload',
    ingestedAt: new Date().toISOString(),
    docs,
  };

  ensureDataDir();
  fs.mkdirSync(dataFile('rag'), { recursive: true });
  fs.writeFileSync(corpusPath(opts.agentId), JSON.stringify(corpus, null, 2), 'utf8');
  await mirrorToPrisma(opts.agentId, docs);

  console.log(
    `[local-ingest] agent=${opts.agentId} docs=${docs.length} pdf=${docs.filter((d) => d.contentBase64).length} skipped=${skipped.length}`
  );
  return { ...corpus, skipped };
}
