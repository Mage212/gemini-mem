#!/usr/bin/env node

/**
 * antigravity-mem init
 *
 * One-command onboarding for end users.
 * Detects installed IDEs and writes MCP configs for each selected one.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.antigravity-mem');
const DB_PATH = path.join(DATA_DIR, 'memory.db');

// ─── Supported IDEs ───────────────────────────────────────────────────────────

interface IdeTarget {
  key: string;
  name: string;
  configPath: string;
  /** When true, merge mcpServers into the existing JSON instead of overwriting. */
  merge: boolean;
}

const SUPPORTED_IDES: IdeTarget[] = [
  {
    key: 'antigravity',
    name: 'Antigravity IDE / Gemini CLI',
    configPath: path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'),
    merge: false,
  },
  {
    key: 'claude',
    name: 'Claude Code',
    configPath: path.join(HOME, '.claude', 'claude.json'),
    merge: true,
  },
  {
    key: 'cursor',
    name: 'Cursor',
    configPath: path.join(HOME, '.cursor', 'mcp.json'),
    merge: true,
  },
  {
    key: 'windsurf',
    name: 'Windsurf',
    configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    merge: false,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function log(msg: string) { console.log(`  ${msg}`); }
function success(msg: string) { console.log(`  ✅ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }

function writeIdeConfig(ide: IdeTarget, serverEntry: object): void {
  const dir = path.dirname(ide.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let config: any = {};
  if (ide.merge && fs.existsSync(ide.configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(ide.configPath, 'utf-8'));
    } catch {
      // Corrupt file — start fresh for our key only
    }
  }

  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers['antigravity-memory'] = serverEntry;

  fs.writeFileSync(ide.configPath, JSON.stringify(config, null, 2) + '\n');
}

// ─── Main Init Flow ───────────────────────────────────────────────────────────

export async function runInit() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🚀 Antigravity Memory — Setup Wizard     ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  Persistent memory for your AI coding tools  ║');
  console.log('  ║  Never lose context across sessions again!   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // ─── Step 1: Gemini API key ─────────────────────────────────────────────────

  log('Step 1/3: Gemini API Key');
  log('────────────────────────');
  log('You need a Gemini API key for memory compression & summarization.');
  log('Get one free at: https://aistudio.google.com/apikey');
  log('');

  // Try to find an existing key from any already-configured IDE
  let existingApiKey = '';
  for (const ide of SUPPORTED_IDES) {
    if (fs.existsSync(ide.configPath)) {
      try {
        const c = JSON.parse(fs.readFileSync(ide.configPath, 'utf-8'));
        const k = c?.mcpServers?.['antigravity-memory']?.env?.GEMINI_API_KEY;
        if (k) { existingApiKey = k; break; }
      } catch { /* ignore */ }
    }
  }

  let apiKey = '';
  if (existingApiKey) {
    const masked = existingApiKey.slice(0, 8) + '...' + existingApiKey.slice(-4);
    const useExisting = await ask(`  Use existing key (${masked})? (Y/n): `);
    if (useExisting.toLowerCase() !== 'n') {
      apiKey = existingApiKey;
    }
  }

  if (!apiKey) {
    apiKey = await ask('  Enter your Gemini API key: ');
    if (!apiKey) {
      warn('No API key provided. Exiting.');
      process.exit(1);
    }
    if (!apiKey.startsWith('AIza')) {
      warn('That doesn\'t look like a valid Gemini API key (should start with "AIza").');
      const proceed = await ask('  Continue anyway? (y/N): ');
      if (proceed.toLowerCase() !== 'y') process.exit(1);
    }
  }
  success('API key configured');

  // ─── Step 2: Database directory ─────────────────────────────────────────────

  log('');
  log('Step 2/3: Database Setup');
  log('────────────────────────');

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    success(`Created data directory: ${DATA_DIR}`);
  } else {
    info(`Data directory already exists: ${DATA_DIR}`);
  }

  // ─── Step 3: IDE selection ───────────────────────────────────────────────────

  log('');
  log('Step 3/3: IDE Configuration');
  log('───────────────────────────');
  log('Which IDEs should receive the MCP config?');
  log('');

  SUPPORTED_IDES.forEach((ide, i) => {
    const exists = fs.existsSync(ide.configPath);
    const already = exists ? ' (config exists)' : '';
    log(`  ${i + 1}. ${ide.name}${already}`);
    log(`     ${ide.configPath}`);
  });

  log('');
  const raw = await ask('  Enter numbers separated by commas, or "all" [default: all]: ');
  const input = raw.trim().toLowerCase();

  let selectedIdes: IdeTarget[];
  if (!input || input === 'all') {
    selectedIdes = SUPPORTED_IDES;
  } else {
    const indices = input
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < SUPPORTED_IDES.length);

    if (indices.length === 0) {
      warn('No valid selection. Exiting.');
      process.exit(1);
    }
    selectedIdes = indices.map((i) => SUPPORTED_IDES[i]);
  }

  // Detect install method once
  const { execSync } = require('child_process');
  let useGlobalBinary = false;
  try {
    execSync('antigravity-mem --version', { stdio: 'ignore' });
    useGlobalBinary = true;
  } catch { /* not globally installed */ }

  const command = useGlobalBinary ? 'antigravity-mem' : 'npx';
  const args = useGlobalBinary ? ['mcp-serve'] : ['-y', 'antigravity-memory', 'mcp-serve'];

  const serverEntry = {
    command,
    args,
    env: {
      ANTIGRAVITY_MEM_DB: DB_PATH,
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: 'gemini-2.5-flash-lite',
    },
  };

  log('');
  for (const ide of selectedIdes) {
    try {
      writeIdeConfig(ide, serverEntry);
      success(`${ide.name} — config written to ${ide.configPath}`);
    } catch (err: any) {
      warn(`${ide.name} — failed to write config: ${err.message}`);
    }
  }

  // ─── Done ───────────────────────────────────────────────────────────────────

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║          ✅ Setup Complete!                  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  log('What happens now:');
  log('');
  log('  1. Run: antigravity-mem verify  (checks setup)');
  log('  2. Restart your IDE(s)');
  log('  3. Start coding — memory tools are auto-available');
  log('  4. Your AI assistant can now call:');
  log('     • memory_start_session       — begin tracking a task');
  log('     • memory_save_note           — capture prompt/response pairs');
  log('     • memory_observe             — record code changes');
  log('     • memory_end_session         — summarize & compress');
  log('     • memory_get_context         — load past session knowledge');
  log('     • memory_list_sessions       — browse session history');
  log('     • memory_cleanup_sessions    — prune stale/old sessions');
  log('     • memory_delete_session      — remove a specific session');
  log('');
  log(`  Memory database: ${DB_PATH}`);
  console.log('');
  log('🧠 Never lose coding context again!');
  console.log('');
}

if (require.main === module) {
  runInit().catch((err) => {
    console.error('Init failed:', err.message);
    process.exit(1);
  });
}
