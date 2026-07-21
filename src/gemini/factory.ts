import { LLMClient } from './client-interface.js';
import { GeminiClient } from './client.js';
import { AgyCliClient } from './agy-client.js';
import { FallbackLLMClient } from './fallback-client.js';

export function createLLMClient(): LLMClient {
  const provider = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  const mock = process.env.MOCK_GEMINI === '1';

  if (mock) {
    console.error('[LLM Factory] MOCK_GEMINI=1 detected - using GeminiClient in mock mode');
    return new GeminiClient();
  }

  if (provider === 'agy') {
    console.error('[LLM Factory] Provider explicit: AGY CLI');
    return new AgyCliClient();
  }

  if (provider === 'gemini-api' || provider === 'api') {
    console.error('[LLM Factory] Provider explicit: Gemini API');
    return new GeminiClient();
  }

  // Provider = 'auto'
  console.error('[LLM Factory] Provider: AUTO (Agy CLI primary with Gemini API fallback)');
  const agyClient = new AgyCliClient();

  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiClient = new GeminiClient();
      return new FallbackLLMClient(agyClient, geminiClient);
    } catch (err: any) {
      console.warn('[LLM Factory] Failed to initialize fallback GeminiClient:', err?.message || err);
    }
  }

  return agyClient;
}
