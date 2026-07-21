import { LLMClient, CompressInput } from './client-interface.js';

export class FallbackLLMClient implements LLMClient {
  constructor(
    private primary: LLMClient,
    private secondary: LLMClient
  ) {
    console.error(`[FallbackLLMClient] Initialized with primary=${primary.getModelName()} and secondary=${secondary.getModelName()}`);
  }

  getModelName(): string {
    return `${this.primary.getModelName()} (fallback: ${this.secondary.getModelName()})`;
  }

  async compressObservation(input: CompressInput): Promise<string> {
    try {
      return await this.primary.compressObservation(input);
    } catch (err: any) {
      console.warn(`[FallbackLLMClient] Primary LLM client failed during compressObservation: ${err?.message || err}. Falling back to secondary...`);
      return await this.secondary.compressObservation(input);
    }
  }

  async summarizeSession(userPrompt: string, observations: string[]): Promise<string> {
    try {
      return await this.primary.summarizeSession(userPrompt, observations);
    } catch (err: any) {
      console.warn(`[FallbackLLMClient] Primary LLM client failed during summarizeSession: ${err?.message || err}. Falling back to secondary...`);
      return await this.secondary.summarizeSession(userPrompt, observations);
    }
  }
}
