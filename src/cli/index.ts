#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('antigravity-mem')
  .description('Persistent memory layer for Antigravity IDE / Gemini CLI')
  .version('0.4.1');

// ─── Init command (no DB needed) ─────────────────────────────────────────────

program
  .command('init')
  .description('Set up antigravity-mem for your IDE (interactive wizard)')
  .action(async () => {
    const { runInit } = await import('./init');
    await runInit();
  });

// ─── MCP server command (called by Antigravity IDE) ─────────────────────────

program
  .command('mcp-serve')
  .description('Start the MCP server (called by Antigravity IDE via MCP config)')
  .action(async () => {
    await import('../mcp/server');
  });

// ─── Verify command ─────────────────────────────────────────────────────────

program
  .command('verify')
  .description('Check that antigravity-mem is set up correctly')
  .action(() => {
    const HOME = os.homedir();
    const configPath = path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json');
    const dataDir = path.join(HOME, '.antigravity-mem');
    let ok = true;

    // Check 1: MCP config exists
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const server = config?.mcpServers?.['antigravity-memory'];
        if (server?.command && server?.args) {
          console.log('  ✅ MCP config found at', configPath);
        } else {
          console.log('  ❌ MCP config missing "antigravity-memory" server entry');
          ok = false;
        }
      } catch {
        console.log('  ❌ MCP config is invalid JSON:', configPath);
        ok = false;
      }
    } else {
      console.log('  ❌ MCP config not found. Run: antigravity-mem init');
      ok = false;
    }

    // Check 2: Data directory
    if (fs.existsSync(dataDir)) {
      console.log('  ✅ Data directory exists:', dataDir);
    } else {
      console.log('  ⚠️  Data directory not found (will be created on first use):', dataDir);
    }

    // Check 3: Gemini API key
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey) {
      console.log('  ✅ GEMINI_API_KEY set in environment');
    } else {
      // Check if it's in the MCP config
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const key = config?.mcpServers?.['antigravity-memory']?.env?.GEMINI_API_KEY;
        if (key) {
          console.log('  ✅ GEMINI_API_KEY set in MCP config');
        } else {
          console.log('  ❌ GEMINI_API_KEY not found. Run: antigravity-mem init');
          ok = false;
        }
      } catch {
        console.log('  ❌ Cannot check GEMINI_API_KEY (config missing)');
        ok = false;
      }
    }

    // Check 4: Database connectivity
    try {
      const db = getDb();
      db.close();
      console.log('  ✅ Database is accessible');
    } catch (err: any) {
      console.log('  ⚠️  Database not yet initialized (normal before first session)');
    }

    console.log('');
    if (ok) {
      console.log('  All checks passed! Restart Antigravity IDE to activate memory tools.');
    } else {
      console.log('  Some checks failed. Run "antigravity-mem init" to fix.');
    }
  });

// ─── Stats command ──────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Show memory usage statistics')
  .action(() => {
    try {
      const db = getDb();
      const stats = db.getStats();

      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║     Antigravity Memory Stats         ║');
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
      console.log(`  Sessions:      ${stats.sessionCount}`);
      console.log(`  Notes:         ${stats.noteCount}`);
      console.log(`  Observations:  ${stats.observationCount}`);
      console.log(`  Tokens saved:  ${stats.tokensSaved.toLocaleString()}`);
      if (stats.originalTokens > 0) {
        const ratio = ((stats.tokensSaved / stats.originalTokens) * 100).toFixed(1);
        console.log(`  Compression:   ${ratio}% reduction`);
      }
      if (stats.lastSessionCreatedAt) {
        const date = new Date(stats.lastSessionCreatedAt).toISOString().split('T')[0];
        console.log(`  Last session:  ${date}`);
      }
      console.log('');

      db.close();
    } catch (err: any) {
      console.log('  No data yet. Start using antigravity-mem to see stats.');
    }
  });

// ─── Commands that need DB ───────────────────────────────────────────────────
// Lazy-load DB to avoid crashing on `init` (user might not have DB yet)

function getDb() {
  const { MemoryDatabase } = require('../core/database');
  return new MemoryDatabase();
}

function getContext(db: any) {
  const { ContextManager } = require('../core/context-manager');
  return new ContextManager(db);
}

program
  .command('start')
  .requiredOption('-p, --project <path>', 'project path')
  .option('-u, --user-prompt <prompt>', 'initial user prompt')
  .action((opts) => {
    const db = getDb();
    const session = db.createSession(opts.project, opts.userPrompt);
    console.log(JSON.stringify(session, null, 2));
  });

program
  .command('record-call')
  .requiredOption('-s, --session <id>', 'session id')
  .requiredOption('-n, --name <function>', 'function name')
  .option('-a, --args <json>', 'function args JSON')
  .action((opts) => {
    const db = getDb();
    const args = opts.args ? JSON.parse(opts.args) : undefined;
    const obs = db.saveObservation(opts.session, opts.name, args);
    console.log(JSON.stringify(obs, null, 2));
  });

program
  .command('record-result')
  .requiredOption('-o, --observation <id>', 'observation id')
  .requiredOption('-r, --result <json>', 'result JSON')
  .action((opts) => {
    const db = getDb();
    const result = JSON.parse(opts.result);
    db.updateObservationResult(opts.observation, result);
    console.log('ok');
  });

program
  .command('compress')
  .requiredOption('-o, --observation <id>', 'observation id')
  .action(async (opts) => {
    const db = getDb();
    const obs = db.getObservation(opts.observation);
    if (!obs) throw new Error('observation not found');
    const { createLLMClient } = require('../gemini/factory');
    const llm = createLLMClient();
    const compressed = await llm.compressObservation({
      functionName: obs.function_name,
      functionArgs: obs.function_args,
      functionResult: obs.function_result
    });

    const originalTokens = estimateTokens(`${obs.function_args || ''}${obs.function_result || ''}`);
    const compressedTokens = estimateTokens(compressed);
    db.markObservationCompressed(obs.id, compressed, originalTokens, compressedTokens);
    console.log(compressed);
  });

program
  .command('context')
  .requiredOption('-p, --project <path>', 'project path')
  .option('-q, --prompt <prompt>', 'current prompt')
  .action((opts) => {
    const db = getDb();
    const context = getContext(db);
    const ctx = context.buildContext({ projectPath: opts.project, currentPrompt: opts.prompt });
    console.log(ctx);
  });

program
  .command('summarize')
  .requiredOption('-s, --session <id>', 'session id')
  .action(async (opts) => {
    const db = getDb();
    const { createLLMClient } = require('../gemini/factory');
    const { SessionSummarizer } = require('../gemini/summarizer');
    const llm = createLLMClient();
    const summarizer = new SessionSummarizer(db, llm);
    const summary = await summarizer.summarize(opts.session);
    console.log(summary);
  });

program.parse();

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
