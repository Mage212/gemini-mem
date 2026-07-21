export interface CompressInput {
  functionName: string;
  functionArgs?: string;
  functionResult?: string;
}

export interface LLMClient {
  getModelName(): string;
  compressObservation(input: CompressInput): Promise<string>;
  summarizeSession(userPrompt: string, observations: string[]): Promise<string>;
}
