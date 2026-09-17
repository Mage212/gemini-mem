import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LLMClient, CompressInput } from './client-interface.js';
import { buildCompressionPrompt, buildSummaryPrompt } from './prompt-builder.js';

const CONV_ID_RE = /Created conversation ([0-9a-f-]{36})/;
const AGY_STARTUP_GRACE_MS = 45_000;
const AGY_WATCHDOG_POLL_MS = 1_000;

export interface AgyClientConfig {
  agyPath?: string;
  modelName?: string;
  timeoutMs?: number;
  mock?: boolean;
}

export interface ResolvedAgyExecutable {
  executable: string;
  argsPrefix: string[];
  isShellRequired: boolean;
}

export function resolveAgyPath(customPath?: string): ResolvedAgyExecutable {
  if (customPath) {
    if (customPath.endsWith('.js')) {
      return { executable: process.execPath, argsPrefix: [customPath], isShellRequired: false };
    }
    return {
      executable: customPath,
      argsPrefix: [],
      isShellRequired: process.platform === 'win32' && (customPath.endsWith('.cmd') || customPath.endsWith('.bat'))
    };
  }

  const envPath = process.env.AGY_PATH;
  if (envPath) {
    if (envPath.endsWith('.js')) {
      return { executable: process.execPath, argsPrefix: [envPath], isShellRequired: false };
    }
    return {
      executable: envPath,
      argsPrefix: [],
      isShellRequired: process.platform === 'win32' && (envPath.endsWith('.cmd') || envPath.endsWith('.bat'))
    };
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const defaultPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
      if (fs.existsSync(defaultPath)) {
        return { executable: defaultPath, argsPrefix: [], isShellRequired: false };
      }
    }

    try {
      const output = execSync('where.exe agy', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const firstLine = output.split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return {
          executable: firstLine,
          argsPrefix: [],
          isShellRequired: firstLine.endsWith('.cmd') || firstLine.endsWith('.bat')
        };
      }
    } catch {
      // Fallback
    }

    return { executable: 'agy', argsPrefix: [], isShellRequired: true };
  }

  return { executable: 'agy', argsPrefix: [], isShellRequired: false };
}

function findJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseAgyOutput(stdout: string, operationName: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Empty response returned by agy CLI during ${operationName}`);
  }

  try {
    const envelope = JSON.parse(trimmed);
    if (envelope && typeof envelope === 'object') {
      if (envelope.status === 'ERROR') {
        throw new Error(`AGY CLI backend error: ${envelope.error || 'Unknown error'}`);
      }
      if (typeof envelope.structured_output === 'object' && envelope.structured_output) {
        return JSON.stringify(envelope.structured_output);
      }
      if (typeof envelope.response === 'string' && envelope.response.trim()) {
        return envelope.response.trim();
      }
    }
  } catch (err: any) {
    if (err.message?.startsWith('AGY CLI backend error:')) {
      throw err;
    }
  }

  const jsonMatch = findJsonObject(trimmed);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch);
      if (parsed && typeof parsed.response === 'string' && parsed.response.trim()) {
        return parsed.response.trim();
      }
      return jsonMatch;
    } catch {
      return jsonMatch;
    }
  }

  const cleaned = trimmed.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!cleaned) {
    throw new Error(`No usable response returned by agy CLI during ${operationName}`);
  }
  return cleaned;
}

export class AgyCliClient implements LLMClient {
  private agyPath: string;
  private modelName: string;
  private timeoutMs: number;
  private mock: boolean;

  constructor(config: AgyClientConfig = {}) {
    this.mock = config.mock ?? (process.env.MOCK_GEMINI === '1');
    this.agyPath = config.agyPath || process.env.AGY_PATH || 'agy';
    this.modelName = config.modelName || process.env.AGY_MODEL || 'agy-cli';
    this.timeoutMs = config.timeoutMs || Number(process.env.AGY_TIMEOUT_MS) || 120_000;

    if (this.mock) {
      console.error('[AGY Client] MOCK mode enabled');
    } else {
      console.error('[AGY Client] Initialized', {
        binary: this.agyPath,
        model: this.modelName,
        timeoutMs: this.timeoutMs
      });
    }
  }

  getModelName(): string {
    return this.modelName;
  }

  async compressObservation({ functionName, functionArgs = '', functionResult = '' }: CompressInput): Promise<string> {
    if (this.mock) {
      return `MOCK (AGY): ${functionName} -> ${functionArgs?.slice(0, 80)} | result: ${functionResult?.slice(0, 80)}`;
    }

    const prompt = buildCompressionPrompt(functionName, functionArgs, functionResult);
    return this.runAgyPrompt(prompt, `compressObservation(${functionName})`);
  }

  async summarizeSession(userPrompt: string, observations: string[]): Promise<string> {
    if (this.mock) {
      const joined = observations.slice(0, 5).join(' | ');
      return `MOCK SUMMARY (AGY): Goal=${userPrompt}. Observations=${joined}`;
    }

    const prompt = buildSummaryPrompt(userPrompt, observations);
    return this.runAgyPrompt(prompt, 'summarizeSession');
  }

  private async runAgyPrompt(prompt: string, operationName: string): Promise<string> {
    const logFilePath = path.join(
      os.tmpdir(),
      `agy_${Date.now()}_${Math.random().toString(36).slice(2)}.log`
    );

    const resolved = resolveAgyPath(this.agyPath !== 'agy' ? this.agyPath : undefined);
    const args: string[] = [
      ...resolved.argsPrefix,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--log-file', logFilePath
    ];

    const targetModel = process.env.AGY_MODEL || (this.modelName !== 'agy-cli' ? this.modelName : undefined);
    if (targetModel) {
      args.push('--model', targetModel);
    }

    console.error(`[AGY Client] Executing ${operationName} via CLI (${resolved.executable}) with stdin pipe...`);

    let stdout = '';
    let stderr = '';
    let watchdogTimer: NodeJS.Timeout | null = null;
    let runTimeoutTimer: NodeJS.Timeout | null = null;
    let procKilled = false;

    try {
      return await new Promise<string>((resolve, reject) => {
        const proc = spawn(resolved.executable, args, {
          shell: resolved.isShellRequired,
          env: {
            ...process.env,
            NO_COLOR: '1',
            TERM: 'dumb'
          }
        });

        const killProcess = (reason: string) => {
          if (!procKilled) {
            procKilled = true;
            try {
              proc.kill();
            } catch {}
          }
        };

        const startTime = Date.now();
        watchdogTimer = setInterval(() => {
          if (Date.now() - startTime >= AGY_STARTUP_GRACE_MS) {
            let progressMade = false;
            try {
              if (fs.existsSync(logFilePath)) {
                const logContent = fs.readFileSync(logFilePath, 'utf-8');
                progressMade = CONV_ID_RE.test(logContent);
              }
            } catch {}

            if (!progressMade) {
              console.warn(`[AGY Client] Startup stall detected in ${operationName} (no conversation created in ${AGY_STARTUP_GRACE_MS}ms). Killing process...`);
              killProcess('startup_stall');
              if (watchdogTimer) clearInterval(watchdogTimer);
              reject(new Error(`AGY CLI startup stalled (no progress detected within ${AGY_STARTUP_GRACE_MS}ms)`));
            } else {
              if (watchdogTimer) clearInterval(watchdogTimer);
            }
          }
        }, AGY_WATCHDOG_POLL_MS);

        runTimeoutTimer = setTimeout(() => {
          killProcess('timeout');
          reject(new Error(`AGY CLI timed out after ${this.timeoutMs}ms during ${operationName}`));
        }, this.timeoutMs);

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8');
        });

        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8');
        });

        proc.on('error', (err: Error) => {
          killProcess('error');
          reject(new Error(`AGY CLI spawn error during ${operationName}: ${err.message}`));
        });

        proc.on('close', (code: number | null) => {
          if (watchdogTimer) clearInterval(watchdogTimer);
          if (runTimeoutTimer) clearTimeout(runTimeoutTimer);

          if (procKilled) {
            return;
          }

          if (code !== 0 && !stdout.trim()) {
            const errorMsg = stderr.trim() || `Process exited with code ${code}`;
            console.error(`[AGY Client] Error during ${operationName}:`, errorMsg);
            return reject(new Error(`AGY CLI execution failed during ${operationName}: ${errorMsg}`));
          }

          try {
            const result = parseAgyOutput(stdout, operationName);
            console.error(`[AGY Client] ${operationName} completed successfully`, { responseLength: result.length });
            resolve(result);
          } catch (parseErr: any) {
            const errorMsg = parseErr?.message || String(parseErr);
            console.error(`[AGY Client] Parse error during ${operationName}:`, errorMsg);
            reject(new Error(`AGY CLI execution failed during ${operationName}: ${errorMsg}`));
          }
        });

        proc.stdin.write(prompt, 'utf-8', (err) => {
          if (err) {
            killProcess('stdin_error');
            reject(new Error(`Failed to write prompt to agy stdin: ${err.message}`));
          } else {
            proc.stdin.end();
          }
        });
      });
    } finally {
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (runTimeoutTimer) clearTimeout(runTimeoutTimer);
      try {
        if (fs.existsSync(logFilePath)) {
          fs.unlinkSync(logFilePath);
        }
      } catch {}
    }
  }
}

