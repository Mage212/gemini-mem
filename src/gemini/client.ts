import { GoogleGenerativeAI } from '@google/generative-ai';

export interface CompressInput {
  functionName: string;
  functionArgs?: string;
  functionResult?: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

function isRateLimited(err: any): boolean {
  return (
    err?.status === 429 ||
    err?.message?.includes('429') ||
    err?.message?.includes('quota') ||
    err?.message?.includes('RESOURCE_EXHAUSTED')
  );
}

function allowMockFallback(): boolean {
  // Opt-in only. Silent mock fallback previously hid API failures from the agent.
  return process.env.MOCK_GEMINI_FALLBACK === '1';
}

export class GeminiClient {
  private client: GoogleGenerativeAI;
  private modelName: string;
  private mock: boolean;

  constructor(private apiKey: string = process.env.GEMINI_API_KEY || '') {
    this.mock = process.env.MOCK_GEMINI === '1';
    if (this.mock) {
      console.error('[Gemini] MOCK_GEMINI=1 - GeminiClient will NOT call real API');
    }

    if (!this.mock && !apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    this.client = this.mock ? ({} as GoogleGenerativeAI) : new GoogleGenerativeAI(apiKey);
    this.modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    console.error('[Gemini] Client initialized', {
      mock: this.mock,
      model: this.modelName
    });
  }

  getModelName(): string {
    return this.modelName;
  }

  async compressObservation({ functionName, functionArgs = '', functionResult = '' }: CompressInput): Promise<string> {
    if (this.mock) {
      console.error('[Gemini] compressObservation MOCK mode - returning fake data');
      return this.mockCompress(functionName, functionArgs, functionResult);
    }

    const prompt = this.buildCompressionPrompt(functionName, functionArgs, functionResult);
    console.error('[Gemini] compressObservation calling real API...', {
      model: this.modelName,
      functionName,
      argsLength: functionArgs?.length ?? 0,
      resultLength: functionResult?.length ?? 0,
      promptLength: prompt.length
    });

    try {
      return await this.generate(prompt, { temperature: 0.2, maxOutputTokens: 400 });
    } catch (err: any) {
      console.error('[Gemini] compressObservation error:', err?.message || err);
      if (isRateLimited(err)) {
        console.error('[Gemini] Rate limited — waiting 60s before retry...');
        await new Promise((r) => setTimeout(r, 60_000));
        try {
          const retryText = await this.generate(prompt, { temperature: 0.2, maxOutputTokens: 400 });
          console.error('[Gemini] compressObservation RETRY succeeded', { responseLength: retryText.length });
          return retryText;
        } catch (retryErr: any) {
          console.error('[Gemini] compressObservation RETRY also failed:', retryErr?.message || retryErr);
          err = retryErr;
        }
      }
      if (allowMockFallback()) {
        console.warn('[Gemini] MOCK_GEMINI_FALLBACK=1 — returning mock compression');
        return this.mockCompress(functionName, functionArgs, functionResult);
      }
      throw this.wrapError('compressObservation', err);
    }
  }

  async summarizeSession(userPrompt: string, observations: string[]): Promise<string> {
    if (this.mock) {
      console.error('[Gemini] summarizeSession MOCK mode - returning fake data');
      return this.mockSummarize(userPrompt, observations);
    }

    const prompt = this.buildSummaryPrompt(userPrompt, observations);
    console.error('[Gemini] summarizeSession calling real API...', {
      model: this.modelName,
      userPromptLength: userPrompt.length,
      observationsCount: observations.length,
      promptLength: prompt.length
    });

    try {
      return await this.generate(prompt, { temperature: 0.3, maxOutputTokens: 800 });
    } catch (err: any) {
      console.error('[Gemini] summarizeSession error:', err?.message || err);
      if (isRateLimited(err)) {
        console.error('[Gemini] Rate limited — waiting 60s before retry...');
        await new Promise((r) => setTimeout(r, 60_000));
        try {
          const retryText = await this.generate(prompt, { temperature: 0.3, maxOutputTokens: 800 });
          console.error('[Gemini] summarizeSession RETRY succeeded', { responseLength: retryText.length });
          return retryText;
        } catch (retryErr: any) {
          console.error('[Gemini] summarizeSession RETRY also failed:', retryErr?.message || retryErr);
          err = retryErr;
        }
      }
      if (allowMockFallback()) {
        console.warn('[Gemini] MOCK_GEMINI_FALLBACK=1 — returning mock summary');
        return this.mockSummarize(userPrompt, observations);
      }
      throw this.wrapError('summarizeSession', err);
    }
  }

  private async generate(
    prompt: string,
    generationConfig: { temperature: number; maxOutputTokens: number }
  ): Promise<string> {
    const model = this.client.getGenerativeModel({ model: this.modelName });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        ...generationConfig,
        ...({
          thinkingConfig: {
            thinkingLevel: 'MINIMAL'
          }
        } as any)
      }
    });

    const parts = result.response.candidates?.[0]?.content?.parts || [];
    const cleanParts = parts.filter((part: any) => !part.thought);
    const text = cleanParts.length > 0
      ? cleanParts.map((part: any) => part.text || '').join('')
      : result.response.text();

    console.error('[Gemini] response received', { responseLength: text.length });
    return text;
  }

  private wrapError(op: string, err: any): Error {
    const message = err?.message || String(err);
    if (isRateLimited(err)) {
      return new Error(
        `Gemini API rate limit/quota exceeded during ${op}. Set a valid GEMINI_API_KEY with available quota and retry.`
      );
    }
    if (/API_KEY|api key|permission|401|403/i.test(message)) {
      return new Error(
        `Gemini API authentication failed during ${op}: ${message}. Check GEMINI_API_KEY.`
      );
    }
    return new Error(`Gemini API failed during ${op}: ${message}`);
  }

  private buildCompressionPrompt(fn: string, args: string, res: string): string {
    return [
      'Summarize this coding action concisely but thoroughly (150-250 tokens):',
      `Function: ${fn}`,
      `Args: ${args?.slice(0, 2000)}`,
      `Result: ${res?.slice(0, 2000)}`,
      '',
      'Your summary MUST include:',
      '- What specific files/components were affected',
      '- What changed (additions, modifications, deletions, refactors)',
      '- Why it matters (bug fix, new feature, config change, dependency update)',
      '- Any key decisions or trade-offs visible in the change',
      '',
      'Write in dense, informative prose. Skip boilerplate and filler.'
    ].join('\n');
  }

  private buildSummaryPrompt(userPrompt: string, observations: string[]): string {
    const lines = observations.map((obs, i) => `${i + 1}. ${obs}`).join('\n');
    return [
      'You are summarizing a coding session for a developer memory system.',
      'The summary will be stored and used to restore context in future sessions.',
      '',
      `User goal: ${userPrompt}`,
      '',
      'Actions taken during the session:',
      lines,
      '',
      'Write a detailed summary (6-10 sentences, ~200-400 words) covering:',
      '1. **What was accomplished**: The main outcomes and deliverables.',
      '2. **Key files and components**: Specific files modified/created and their roles.',
      '3. **Technical decisions**: Architecture choices, patterns used, trade-offs made.',
      '4. **Current state**: What works now, what was left incomplete or needs follow-up.',
      '5. **Learnings and gotchas**: Bugs encountered, workarounds applied, insights gained.',
      '',
      'Write in clear, dense prose (not bullets). This summary must be useful enough',
      'that a developer reading it cold can understand what happened and continue the work.'
    ].join('\n');
  }

  private mockCompress(fn: string, args: string, res: string): string {
    return `MOCK: ${fn} -> ${args?.slice(0, 80)} | result: ${res?.slice(0, 80)}`;
  }

  private mockSummarize(userPrompt: string, observations: string[]): string {
    const joined = observations.slice(0, 5).join(' | ');
    return `MOCK SUMMARY: Goal=${userPrompt}. Observations=${joined}`;
  }
}
