#!/usr/bin/env node

import path from 'path';
import os from 'os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { MemoryDatabase } from '../core/database';
import { ContextManager } from '../core/context-manager';
import { CompressionQueue } from '../core/compression-queue';
import { GeminiClient } from '../gemini/client';
import { SessionSummarizer } from '../gemini/summarizer';

const dbPath = process.env.ANTIGRAVITY_MEM_DB || path.join(os.homedir(), '.antigravity-mem', 'memory.db');
console.error('[MCP] Initializing with DB:', dbPath);
console.error('[MCP] Gemini model:', process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite');

let db: MemoryDatabase;
let contextBuilder: ContextManager;
let gemini: GeminiClient;
let summarizer: SessionSummarizer;
let compressionQueue: CompressionQueue;

try {
  db = new MemoryDatabase(dbPath);
  contextBuilder = new ContextManager(db);
  gemini = new GeminiClient();
  summarizer = new SessionSummarizer(db, gemini);
  compressionQueue = new CompressionQueue(db, gemini);
  compressionQueue.start();
  console.error('[MCP] All modules initialized successfully');
} catch (err: any) {
  console.error('[MCP] FATAL: Failed to initialize modules:', err.message);
  process.exit(1);
}

const server = new McpServer({
  name: 'antigravity-memory',
  version: '0.3.0'
});

server.tool(
  'memory_start_session',
  'Create a new memory session to track coding work for a project. Call this at the START of a task. After making changes, use memory_save_note to record what you did (this is required for good summaries). When done, call memory_end_session.',
  {
    projectPath: z.string().describe('Absolute path to the project directory'),
    userPrompt: z.string().optional().describe('What the user wants to accomplish in this session')
  },
  async ({ projectPath, userPrompt }) => {
    try {
      const session = db.createSession(projectPath, userPrompt);
      return {
        content: [{
          type: 'text' as const,
          text: `Memory session started.\nSession ID: ${session.id}\nProject: ${session.project_path}\nUse this session ID for save_note and end_session calls.`
        }]
      };
    } catch (err: any) {
      console.error('[MCP] memory_start_session error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_get_or_start_session',
  'Return the active session for a project, or start one if none exists. Automatically closes sessions that have been active for more than 24 hours.',
  {
    projectPath: z.string().describe('Absolute path to the project directory'),
    userPrompt: z.string().optional().describe('If creating, initial user prompt')
  },
  async ({ projectPath, userPrompt }) => {
    try {
      const existing = db.getActiveSession(projectPath);
      if (existing) {
        const isStale = Date.now() - existing.created_at > MemoryDatabase.STALE_SESSION_MS;
        if (isStale) {
          db.closeStaleActiveSessions(projectPath);
          const session = db.createSession(projectPath, userPrompt);
          return {
            content: [{ type: 'text' as const, text: `Previous session was stale (>24h old) — auto-closed. New session started: ${session.id}` }]
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Active session found: ${existing.id}` }]
        };
      }
      const session = db.createSession(projectPath, userPrompt);
      return {
        content: [{ type: 'text' as const, text: `No active session found. Started new session: ${session.id}` }]
      };
    } catch (err: any) {
      console.error('[MCP] memory_get_or_start_session error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_save_note',
  'Save a note to the active session. Call this AFTER every significant action to record what happened. This is the PRIMARY way context is captured for future sessions. Be detailed — include file names, what changed, and why. The richer the note, the better the memory.',
  {
    sessionId: z.string().describe('The active session ID'),
    userPrompt: z.string().optional().describe('What the user asked or requested'),
    aiResponse: z.string().optional().describe('Detailed summary of what you did: files created/modified, components added, logic changes, validations added. Be specific with file paths and function names.'),
    annotation: z.string().optional().describe('Key decisions, trade-offs, gotchas, dependencies added, or things left incomplete for follow-up')
  },
  async ({ sessionId, userPrompt, aiResponse, annotation }) => {
    try {
      if (!userPrompt && !aiResponse && !annotation) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one of userPrompt, aiResponse, or annotation' }], isError: true };
      }
      const session = db.getSession(sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Error: session not found: ${sessionId}` }], isError: true };
      }
      const note = db.saveNote(sessionId, userPrompt, aiResponse, annotation, 'manual');
      return { content: [{ type: 'text' as const, text: `Note saved (${note.id}). Prompt/response recorded for future context.` }] };
    } catch (err: any) {
      console.error('[MCP] memory_save_note error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_get_context',
  'Retrieve past session context for a project. Use this at the START of a conversation to load historical knowledge about the codebase — what was done before, key decisions, files modified, etc.',
  {
    projectPath: z.string().describe('Absolute path to the project directory'),
    currentPrompt: z.string().optional().describe('The current user prompt, used to find relevant past sessions')
  },
  async ({ projectPath, currentPrompt }) => {
    try {
      const ctx = contextBuilder.buildContext({
        projectPath,
        currentPrompt: currentPrompt || ''
      });
      return { content: [{ type: 'text' as const, text: ctx }] };
    } catch (err: any) {
      console.error('[MCP] memory_get_context error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_end_session',
  'End and summarize a coding session. Waits briefly for any queued observation compressions, then generates a rich summary using Gemini from saved notes and observations. Call this when the user is done with a task. IMPORTANT: Make sure you called memory_save_note at least once BEFORE calling this, otherwise the summary may be empty.',
  {
    sessionId: z.string().describe('The session ID to finalize')
  },
  async ({ sessionId }) => {
    try {
      const session = db.getSession(sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Error: session not found: ${sessionId}` }], isError: true };
      }

      const drain = await compressionQueue.drain(60_000);
      const countsBefore = db.getObservationCounts(sessionId);
      const failed = countsBefore.observations.failed ?? 0;

      // SessionSummarizer owns endSession (status=completed). Do not call endSession again here.
      const summary = await summarizer.summarize(sessionId);

      const notes: string[] = [];
      if (!drain.drained) {
        notes.push(
          `Warning: compression queue did not fully drain before summarize (${drain.remaining} still pending after ${drain.waitedMs}ms). Notes are still included; some observations may lack compression.`
        );
      }
      if (failed > 0) {
        notes.push(
          `Warning: ${failed} observation compression(s) failed. Check memory_session_status for details; notes still contribute to the summary.`
        );
      }

      const suffix = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Session summarized and saved.\n\nSummary:\n${summary}${suffix}`
        }]
      };
    } catch (err: any) {
      console.error('[MCP] memory_end_session error:', err.message);
      return {
        content: [{ type: 'text' as const, text: `Error summarizing: ${err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  'memory_session_status',
  'Get the current status/counts for a session (observations per status including failed compressions, notes count, summary if present). Use this to check whether background compression succeeded.',
  {
    sessionId: z.string().describe('The session ID to inspect')
  },
  async ({ sessionId }) => {
    try {
      const session = db.getSession(sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Error: session not found: ${sessionId}` }], isError: true };
      }
      const counts = db.getObservationCounts(sessionId);
      const summary = session.summary || '(no summary yet)';
      const failed = counts.observations.failed ?? 0;
      const failedHint = failed > 0
        ? `\nNote: ${failed} compression(s) failed — Gemini API error was recorded on those observations; memory_save_note content is unaffected.`
        : '';
      const statusText = `Session ${sessionId}\nStatus: ${session.status}\nObservations: ${JSON.stringify(counts.observations)}\nNotes: ${counts.notes}\nSummary: ${summary}${failedHint}`;
      return { content: [{ type: 'text' as const, text: statusText }] };
    } catch (err: any) {
      console.error('[MCP] memory_session_status error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_observe',
  'Record a coding action/observation in the current session. Use this when you make a significant change (create file, modify component, fix bug, etc.). Compression is queued in the background and does not block this tool. If compression fails later, the observation is marked failed — check with memory_session_status. Prefer memory_save_note for durable context.',
  {
    sessionId: z.string().describe('The active session ID'),
    action: z.string().describe('What action was performed (e.g., "created file", "modified component", "fixed bug")'),
    details: z.string().describe('Details of the change — files affected, what changed, why'),
    compress: z.boolean().optional().default(true).describe('Whether to queue this for Gemini compression in the background')
  },
  async ({ sessionId, action, details, compress }) => {
    try {
      const session = db.getSession(sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Error: session not found: ${sessionId}` }], isError: true };
      }
      const obs = db.saveObservation(sessionId, action, { details });
      db.updateObservationResult(obs.id, details);

      if (compress) {
        const position = compressionQueue.enqueue({
          observationId: obs.id,
          functionName: action,
          functionArgs: JSON.stringify({ details }),
          functionResult: details
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Observation recorded (${obs.id}): ${action}. Compression queued (position ${position}). Failures appear as status=failed via memory_session_status.`
          }]
        };
      }

      return { content: [{ type: 'text' as const, text: `Observation recorded (${obs.id}): ${action}` }] };
    } catch (err: any) {
      console.error('[MCP] memory_observe error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_list_sessions',
  'List recent coding sessions for a project, including their status, summaries, and observation counts.',
  {
    projectPath: z.string().describe('Absolute path to the project directory'),
    limit: z.number().optional().default(5).describe('Maximum number of sessions to return')
  },
  async ({ projectPath, limit }) => {
    try {
      const sessions = db.getRecentSessions(projectPath, limit);
      if (sessions.length === 0) {
        return { content: [{ type: 'text' as const, text: `No completed sessions found for ${projectPath}` }] };
      }
      const lines = sessions.map((s: any) => {
        const date = new Date(s.created_at).toISOString().split('T')[0];
        return `[${date}] ${s.id} (${s.status}) - ${s.user_prompt || 'No prompt'} | ${s.total_observations} observations`;
      });
      return { content: [{ type: 'text' as const, text: `Recent sessions:\n${lines.join('\n')}` }] };
    } catch (err: any) {
      console.error('[MCP] memory_list_sessions error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_delete_session',
  'Permanently delete a session and all its observations and notes. Use with caution — this cannot be undone.',
  {
    sessionId: z.string().describe('The session ID to delete')
  },
  async ({ sessionId }) => {
    try {
      const session = db.getSession(sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Error: session not found: ${sessionId}` }], isError: true };
      }
      const deleted = db.deleteSession(sessionId);
      return {
        content: [{ type: 'text' as const, text: deleted ? `Session ${sessionId} permanently deleted.` : `Failed to delete session ${sessionId}.` }]
      };
    } catch (err: any) {
      console.error('[MCP] memory_delete_session error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'memory_cleanup_sessions',
  'Prune old completed sessions and auto-close stale active sessions. Useful for reclaiming space or resetting leftover open sessions.',
  {
    projectPath: z.string().describe('Project path to clean up'),
    olderThanDays: z.number().optional().default(30).describe('Delete completed sessions older than this many days (default: 30)'),
    closeStaleAfterHours: z.number().optional().default(24).describe('Auto-close active sessions idle longer than this many hours (default: 24)')
  },
  async ({ projectPath, olderThanDays, closeStaleAfterHours }) => {
    try {
      const staleClosed = db.closeStaleActiveSessions(projectPath, closeStaleAfterHours * 60 * 60 * 1000);
      const pruned = db.pruneSessions(projectPath, olderThanDays);
      return {
        content: [{
          type: 'text' as const,
          text: `Cleanup complete.\nStale active sessions closed: ${staleClosed}\nOld sessions pruned (older than ${olderThanDays} days): ${pruned}`
        }]
      };
    } catch (err: any) {
      console.error('[MCP] memory_cleanup_sessions error:', err.message);
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] antigravity-memory server running on stdio');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
