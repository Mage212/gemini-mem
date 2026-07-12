#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * Experimental / legacy HTTP API for local debugging.
 * Primary production path is MCP (src/mcp/server.ts).
 */
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { MemoryDatabase } from '../core/database';
import { ContextManager } from '../core/context-manager';
import { CompressionQueue } from '../core/compression-queue';
import { GeminiClient } from '../gemini/client';
import { SessionSummarizer } from '../gemini/summarizer';

dotenv.config();

const db = new MemoryDatabase();
const ctx = new ContextManager(db);
const gemini = new GeminiClient();
const summarizer = new SessionSummarizer(db, gemini);
const compressionQueue = new CompressionQueue(db, gemini);
compressionQueue.start();

const MAX_BODY_BYTES = 1_000_000;

function send(res: http.ServerResponse, status: number, body: any, isText = false) {
  const data = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type'
  });
  res.end(data);
}

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) return send(res, 400, { error: 'bad request' });
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') return send(res, 200, {});

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, mock: process.env.MOCK_GEMINI === '1' || undefined });
    }

    if (req.method === 'POST' && url.pathname === '/session/start') {
      const { projectPath, userPrompt } = await parseBody(req);
      if (!projectPath) return send(res, 400, { error: 'projectPath required' });
      const session = db.createSession(projectPath, userPrompt);
      return send(res, 200, { sessionId: session.id, session });
    }

    if (req.method === 'POST' && url.pathname === '/session/end') {
      const { sessionId, summary } = await parseBody(req);
      if (!sessionId) return send(res, 400, { error: 'sessionId required' });
      const session = db.getSession(sessionId);
      if (!session) return send(res, 404, { error: 'session not found' });
      db.endSession(sessionId, summary, 'completed');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/session/status') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return send(res, 400, { error: 'sessionId required' });
      const session = db.getSession(sessionId);
      if (!session) return send(res, 404, { error: 'session not found' });
      const counts = db.getObservationCounts(sessionId);
      return send(res, 200, { session, counts });
    }

    if (req.method === 'GET' && url.pathname === '/session/list') {
      const projectPath = url.searchParams.get('project');
      const limit = Number(url.searchParams.get('limit') || 10);
      if (!projectPath) return send(res, 400, { error: 'project query param required' });
      const active = db.getActiveSession(projectPath);
      const recent = db.getRecentSessions(projectPath, limit);
      return send(res, 200, { active, recent });
    }

    if (req.method === 'POST' && url.pathname === '/observe/call') {
      const { sessionId, functionName, functionArgs, observationType } = await parseBody(req);
      if (!sessionId || !functionName) return send(res, 400, { error: 'sessionId and functionName required' });
      const session = db.getSession(sessionId);
      if (!session) return send(res, 400, { error: 'unknown sessionId' });
      const obs = db.saveObservation(sessionId, functionName, functionArgs, observationType);
      return send(res, 200, { observationId: obs.id, observation: obs });
    }

    if (req.method === 'POST' && url.pathname === '/observe/result') {
      const { observationId, result } = await parseBody(req);
      if (!observationId) return send(res, 400, { error: 'observationId required' });
      db.updateObservationResult(observationId, result);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/compress') {
      const { observationId } = await parseBody(req);
      if (!observationId) return send(res, 400, { error: 'observationId required' });
      const obs = db.getObservation(observationId);
      if (!obs) return send(res, 404, { error: 'observation not found' });
      const position = compressionQueue.enqueue({
        observationId: obs.id,
        functionName: obs.function_name,
        functionArgs: obs.function_args,
        functionResult: obs.function_result
      });
      return send(res, 200, { queued: true, position });
    }

    if (req.method === 'POST' && url.pathname === '/summarize') {
      const { sessionId } = await parseBody(req);
      if (!sessionId) return send(res, 400, { error: 'sessionId required' });
      const drain = await compressionQueue.drain(60_000);
      const summary = await summarizer.summarize(sessionId);
      return send(res, 200, { summary, compressionDrain: drain });
    }

    if (req.method === 'GET' && url.pathname === '/context') {
      const projectPath = url.searchParams.get('project');
      const prompt = url.searchParams.get('prompt') || '';
      if (!projectPath) return send(res, 400, { error: 'project query param required' });
      const context = ctx.buildContext({ projectPath, currentPrompt: prompt });
      return send(res, 200, context, true);
    }

    if (req.method === 'POST' && url.pathname === '/note') {
      const { sessionId, userPrompt, aiResponse, annotation, source } = await parseBody(req);
      if (!sessionId) return send(res, 400, { error: 'sessionId required' });
      if (!userPrompt && !aiResponse && !annotation) {
        return send(res, 400, { error: 'provide at least one of userPrompt, aiResponse, annotation' });
      }
      const session = db.getSession(sessionId);
      if (!session) return send(res, 404, { error: 'session not found' });
      const note = db.saveNote(sessionId, userPrompt, aiResponse, annotation, source || 'manual');
      return send(res, 200, { noteId: note.id });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const sessionCount = db.db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
      const obsCount = db.db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
      const compressedCount = db.db.prepare("SELECT COUNT(*) as c FROM observations WHERE status='compressed'").get().c;
      const notesCount = db.db.prepare('SELECT COUNT(*) as c FROM notes').get().c;
      const tokenStats = db.db.prepare(
        "SELECT COALESCE(SUM(tokens_saved),0) as saved, COALESCE(SUM(original_tokens),0) as original FROM observations WHERE status = 'compressed'"
      ).get();
      const avgCompression = tokenStats.original > 0
        ? Number(((tokenStats.saved / tokenStats.original) * 100).toFixed(2))
        : 0;
      return send(res, 200, {
        sessions: sessionCount,
        observations: obsCount,
        compressed: compressedCount,
        notes: notesCount,
        tokensSaved: tokenStats.saved,
        averageCompressionPct: avgCompression
      });
    }

    if (req.method === 'GET' && url.pathname === '/ui') {
      const uiPath = path.join(process.cwd(), 'web', 'ui.html');
      if (!fs.existsSync(uiPath)) return send(res, 404, { error: 'ui not found' });
      const html = fs.readFileSync(uiPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    return send(res, 404, { error: 'not found' });
  } catch (err: any) {
    console.error('[HTTP]', err);
    return send(res, 500, { error: err?.message || 'internal error' });
  }
});

const port = Number(process.env.PORT || 37777);
const host = '127.0.0.1';
server.listen(port, host, () => {
  console.error(`[HTTP] antigravity-memory API (experimental) on http://${host}:${port}`);
});
