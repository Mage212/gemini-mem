import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDatabase } from '../src/core/database';
import { ContextManager } from '../src/core/context-manager';
import { CompressionQueue } from '../src/core/compression-queue';
import { GeminiClient } from '../src/gemini/client';
import { SessionSummarizer } from '../src/gemini/summarizer';

function tempDbPath() {
  return path.join(os.tmpdir(), `antigravity-mem-test-${Date.now()}-${Math.random()}.db`);
}

const dbPaths: string[] = [];

afterEach(() => {
  while (dbPaths.length) {
    const p = dbPaths.pop()!;
    try {
      fs.unlinkSync(p);
    } catch { /* ignore */ }
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(p + suffix);
      } catch { /* ignore */ }
    }
  }
});

describe('MemoryDatabase path scoping', () => {
  it('stores trailing-slash variants under one project_path', () => {
    const dbFile = tempDbPath();
    dbPaths.push(dbFile);
    const db = new MemoryDatabase(dbFile);
    const s1 = db.createSession('/tmp/my-app/');
    const s2 = db.getActiveSession('/tmp/my-app');
    expect(s2?.id).toBe(s1.id);
    expect(s1.project_path).toBe(s2?.project_path);
    db.close();
  });

  it('aggregates tokens_saved on the session', () => {
    const dbFile = tempDbPath();
    dbPaths.push(dbFile);
    const db = new MemoryDatabase(dbFile);
    const session = db.createSession('/tmp/tokens-app');
    const obs = db.saveObservation(session.id, 'edit', { details: 'x'.repeat(400) });
    db.updateObservationResult(obs.id, 'x'.repeat(400));
    db.markObservationCompressed(obs.id, 'short', 100, 20);
    const updated = db.getSession(session.id)!;
    expect(updated.tokens_saved).toBe(80);
    db.close();
  });
});

describe('ContextManager', () => {
  it('includes active session notes without keyword match', () => {
    const dbFile = tempDbPath();
    dbPaths.push(dbFile);
    const db = new MemoryDatabase(dbFile);
    const session = db.createSession('/tmp/ctx-app', 'Build login');
    db.saveNote(session.id, 'add form', 'Created LoginForm.tsx', 'used zod');
    const ctx = new ContextManager(db).buildContext({
      projectPath: '/tmp/ctx-app',
      currentPrompt: ''
    });
    expect(ctx).toContain('LoginForm.tsx');
    expect(ctx).toMatch(/active/i);
    db.close();
  });
});

describe('SessionSummarizer', () => {
  it('closes empty sessions with completed status', async () => {
    process.env.MOCK_GEMINI = '1';
    const dbFile = tempDbPath();
    dbPaths.push(dbFile);
    const db = new MemoryDatabase(dbFile);
    const gemini = new GeminiClient('unused');
    const summarizer = new SessionSummarizer(db, gemini);
    const session = db.createSession('/tmp/sum-app', 'Explore');
    const summary = await summarizer.summarize(session.id);
    const ended = db.getSession(session.id)!;
    expect(summary).toMatch(/No observations or notes/);
    expect(ended.status).toBe('completed');
    expect(ended.summary).toBeTruthy();
    db.close();
    delete process.env.MOCK_GEMINI;
  });
});

describe('CompressionQueue', () => {
  it('enqueues jobs and reports pending count', async () => {
    process.env.MOCK_GEMINI = '1';
    const dbFile = tempDbPath();
    dbPaths.push(dbFile);
    const db = new MemoryDatabase(dbFile);
    const gemini = new GeminiClient('unused');
    const queue = new CompressionQueue(db, gemini, 50);
    const session = db.createSession('/tmp/queue-app');
    const obs = db.saveObservation(session.id, 'edit', { details: 'hello world' });
    db.updateObservationResult(obs.id, 'hello world');

    const position = queue.enqueue({
      observationId: obs.id,
      functionName: 'edit',
      functionArgs: JSON.stringify({ details: 'hello world' }),
      functionResult: 'hello world'
    });
    expect(position).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 300));
    const updated = db.getObservation(obs.id)!;
    expect(updated.status).toBe('compressed');
    expect(updated.compressed_data).toMatch(/MOCK/);
    queue.stop();
    db.close();
    delete process.env.MOCK_GEMINI;
  });
});
