/**
 * Lab / interim RAG: pull Google Drive folder/file text into a local corpus
 * so agents can answer before Vertex Search Drive connector is fully wired.
 */
import fs from 'fs';
import { dataFile, ensureDataDir } from './data-paths.js';
import { authedDrive } from './drive-oauth.js';

export type LocalRagDoc = {
  id: string;
  name: string;
  mimeType: string;
  text: string;
  webViewLink?: string;
};

export type LocalRagCorpus = {
  agentId: string;
  driveSourceId: string;
  ingestedAt: string;
  docs: LocalRagDoc[];
};

const MAX_FILES = 25;
const MAX_CHARS_PER_FILE = 12_000;
const MAX_TOTAL_CHARS = 80_000;

function corpusPath(agentId: string) {
  return dataFile(`rag/${agentId}.json`);
}

async function readFileText(
  drive: Awaited<ReturnType<typeof authedDrive>>,
  file: { id: string; name?: string | null; mimeType?: string | null }
): Promise<string | null> {
  const mime = file.mimeType || '';
  const id = file.id!;
  try {
    if (mime.startsWith('application/vnd.google-apps.')) {
      if (mime === 'application/vnd.google-apps.folder') return null;
      const exportMime =
        mime === 'application/vnd.google-apps.spreadsheet'
          ? 'text/csv'
          : 'text/plain';
      const res = await drive.files.export(
        { fileId: id, mimeType: exportMime },
        { responseType: 'text' }
      );
      const text = String(res.data || '');
      return text.slice(0, MAX_CHARS_PER_FILE);
    }
    if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/markdown' ||
      mime.endsWith('+json')
    ) {
      const res = await drive.files.get(
        { fileId: id, alt: 'media' },
        { responseType: 'text' }
      );
      return String(res.data || '').slice(0, MAX_CHARS_PER_FILE);
    }
  } catch (err) {
    console.warn('[drive-ingest] skip file', file.name, err);
  }
  return null;
}

async function collectFromFolder(
  drive: Awaited<ReturnType<typeof authedDrive>>,
  folderId: string,
  depth: number,
  acc: LocalRagDoc[],
  totalChars: { n: number }
): Promise<void> {
  if (depth > 2 || acc.length >= MAX_FILES || totalChars.n >= MAX_TOTAL_CHARS) return;
  const res = await drive.files.list({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, webViewLink)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  for (const f of res.data.files || []) {
    if (acc.length >= MAX_FILES || totalChars.n >= MAX_TOTAL_CHARS) break;
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await collectFromFolder(drive, f.id!, depth + 1, acc, totalChars);
      continue;
    }
    const text = await readFileText(drive, f as any);
    if (!text || !text.trim()) continue;
    acc.push({
      id: f.id!,
      name: f.name || '(untitled)',
      mimeType: f.mimeType || 'unknown',
      text,
      webViewLink: f.webViewLink || undefined,
    });
    totalChars.n += text.length;
  }
}

export async function ingestDriveSourceForAgent(opts: {
  sessionId: string;
  agentId: string;
  driveSourceId: string;
}): Promise<LocalRagCorpus> {
  const drive = await authedDrive(opts.sessionId);
  const meta = await drive.files.get({
    fileId: opts.driveSourceId,
    fields: 'id, name, mimeType, webViewLink',
    supportsAllDrives: true,
  });
  const docs: LocalRagDoc[] = [];
  const totalChars = { n: 0 };
  const mime = meta.data.mimeType || '';

  if (mime === 'application/vnd.google-apps.folder') {
    await collectFromFolder(drive, opts.driveSourceId, 0, docs, totalChars);
  } else {
    const text = await readFileText(drive, meta.data as any);
    if (text?.trim()) {
      docs.push({
        id: meta.data.id!,
        name: meta.data.name || '(untitled)',
        mimeType: mime,
        text,
        webViewLink: meta.data.webViewLink || undefined,
      });
    }
  }

  const corpus: LocalRagCorpus = {
    agentId: opts.agentId,
    driveSourceId: opts.driveSourceId,
    ingestedAt: new Date().toISOString(),
    docs,
  };

  ensureDataDir();
  fs.mkdirSync(dataFile('rag'), { recursive: true });
  fs.writeFileSync(corpusPath(opts.agentId), JSON.stringify(corpus, null, 2), 'utf8');

  // Mirror into Cloud SQL when available
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import('./db.js');
      for (const d of docs) {
        await prisma.ragDocument.upsert({
          where: {
            agentId_driveFileId: { agentId: opts.agentId, driveFileId: d.id },
          },
          create: {
            agentId: opts.agentId,
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
      console.warn('[drive-ingest] prisma mirror skipped', err?.message || err);
    }
  }

  console.log(
    `[drive-ingest] agent=${opts.agentId} docs=${docs.length} chars≈${totalChars.n}`
  );
  return corpus;
}

export function loadLocalRagCorpus(agentId: string): LocalRagCorpus | null {
  try {
    const p = corpusPath(agentId);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as LocalRagCorpus;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Async load — file first, then Prisma RagDocument rows */
export async function loadLocalRagCorpusAsync(agentId: string): Promise<LocalRagCorpus | null> {
  const file = loadLocalRagCorpus(agentId);
  if (file?.docs?.length) return file;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { prisma } = await import('./db.js');
    const rows = await prisma.ragDocument.findMany({ where: { agentId } });
    if (!rows.length) return null;
    return {
      agentId,
      driveSourceId: rows[0].driveFileId,
      ingestedAt: rows[0].createdAt.toISOString(),
      docs: rows.map((r) => ({
        id: r.driveFileId,
        name: r.name,
        mimeType: r.mimeType,
        text: r.text,
        webViewLink: r.webViewLink || undefined,
      })),
    };
  } catch {
    return null;
  }
}

export function retrieveFromLocalCorpus(
  agentId: string,
  query: string
): {
  snippets: string[];
  citations: { title?: string; uri?: string; snippet?: string }[];
  ok: boolean;
} {
  const corpus = loadLocalRagCorpus(agentId);
  if (!corpus?.docs?.length) {
    return { snippets: [], citations: [], ok: false };
  }
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const scored = corpus.docs.map((d) => {
    const hay = `${d.name}\n${d.text}`.toLowerCase();
    let score = 0;
    for (const w of q) if (hay.includes(w)) score += 1;
    if (score === 0) score = 0.1;
    return { d, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);
  return {
    ok: true,
    snippets: top.map((t) => `[${t.d.name}]\n${t.d.text.slice(0, 4000)}`),
    citations: top.map((t) => ({
      title: t.d.name,
      uri: t.d.webViewLink,
      snippet: t.d.text.slice(0, 240),
    })),
  };
}
