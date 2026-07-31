import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LLMClient, CompressInput } from './client-interface.js';
import { buildCompressionPrompt, buildSummaryPrompt } from './prompt-builder.js';

const execFileAsync = promisify(execFile);

export interface AgyClientConfig {
  agyPath?: string;
  modelName?: string;
  timeoutMs?: number;
  mock?: boolean;
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
    this.timeoutMs = config.timeoutMs || Number(process.env.AGY_TIMEOUT_MS) || 60_000;

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
    const args: string[] = ['--output-format', 'json'];
    const targetModel = process.env.AGY_MODEL || (this.modelName !== 'agy-cli' ? this.modelName : undefined);
    if (targetModel) {
      args.push('--model', targetModel);
    }

    const MAX_PROMPT_LEN = 40_000;
    let safePrompt = prompt;
    if (prompt.length > MAX_PROMPT_LEN) {
      console.error(`[AGY Client] Warning: Prompt length (${prompt.length}) exceeds safety limit (${MAX_PROMPT_LEN}). Truncating...`);
      safePrompt = prompt.slice(0, MAX_PROMPT_LEN) + '\n...[truncated due to length limit]';
    }
    args.push('-p', safePrompt);

    console.error(`[AGY Client] Executing ${operationName} via CLI (${this.agyPath})...`);

    try {
      const { stdout } = await execFileAsync(this.agyPath, args, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env
      });

      // Try parsing JSON output from agy --output-format json
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === 'object' && typeof parsed.response === 'string') {
          const text = parsed.response.trim();
          console.error(`[AGY Client] ${operationName} completed successfully via JSON output`, {
            responseLength: text.length,
            usage: parsed.usage
          });
          return text;
        }
      } catch {
        // Fallback for older agy CLI versions returning plain text or ANSI
      }

      // Strip ANSI escape codes and clean trailing whitespace
      const cleaned = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();

      if (!cleaned) {
        throw new Error(`Empty response returned by agy CLI during ${operationName}`);
      }

      console.error(`[AGY Client] ${operationName} completed successfully`, { responseLength: cleaned.length });
      return cleaned;
    } catch (err: any) {
      const errorMsg = err?.stderr?.trim() || err?.message || String(err);
      console.error(`[AGY Client] Error during ${operationName}:`, errorMsg);
      throw new Error(`AGY CLI execution failed during ${operationName}: ${errorMsg}`);
    }
  }
}
