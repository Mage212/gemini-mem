import { describe, expect, it } from 'vitest';
import { AgyCliClient } from '../src/gemini/agy-client.js';
import { FallbackLLMClient } from '../src/gemini/fallback-client.js';
import { createLLMClient } from '../src/gemini/factory.js';
import { LLMClient } from '../src/gemini/client-interface.js';

class MockSuccessClient implements LLMClient {
  getModelName() {
    return 'mock-success';
  }
  async compressObservation() {
    return 'compressed by success';
  }
  async summarizeSession() {
    return 'summary by success';
  }
}

class MockFailingClient implements LLMClient {
  getModelName() {
    return 'mock-failing';
  }
  async compressObservation(): Promise<string> {
    throw new Error('Primary failed');
  }
  async summarizeSession(): Promise<string> {
    throw new Error('Primary failed');
  }
}

describe('AgyCliClient', () => {
  it('returns mock responses in mock mode', async () => {
    const client = new AgyCliClient({ mock: true });
    expect(client.getModelName()).toBe('agy-cli');

    const compressed = await client.compressObservation({
      functionName: 'test_func',
      functionArgs: 'args',
      functionResult: 'result'
    });
    expect(compressed).toContain('MOCK (AGY)');

    const summary = await client.summarizeSession('Test goal', ['obs1', 'obs2']);
    expect(summary).toContain('MOCK SUMMARY (AGY)');
  });

  it('stores and exposes custom modelName', () => {
    const client = new AgyCliClient({ mock: true, modelName: 'custom-agy-model' });
    expect(client.getModelName()).toBe('custom-agy-model');
  });
});

describe('FallbackLLMClient', () => {
  it('uses primary when primary succeeds', async () => {
    const primary = new MockSuccessClient();
    const secondary = new MockFailingClient();
    const fallback = new FallbackLLMClient(primary, secondary);

    const compressed = await fallback.compressObservation({ functionName: 'fn' });
    expect(compressed).toBe('compressed by success');
  });

  it('falls back to secondary when primary fails', async () => {
    const primary = new MockFailingClient();
    const secondary = new MockSuccessClient();
    const fallback = new FallbackLLMClient(primary, secondary);

    const compressed = await fallback.compressObservation({ functionName: 'fn' });
    expect(compressed).toBe('compressed by success');

    const summary = await fallback.summarizeSession('goal', ['obs']);
    expect(summary).toBe('summary by success');
  });
});

describe('LLM Factory', () => {
  it('creates GeminiClient when MOCK_GEMINI=1 is set', () => {
    process.env.MOCK_GEMINI = '1';
    const client = createLLMClient();
    expect(client.getModelName()).toBeTruthy();
    delete process.env.MOCK_GEMINI;
  });

  it('respects LLM_PROVIDER=agy in mock mode', () => {
    process.env.MOCK_GEMINI = '1';
    process.env.LLM_PROVIDER = 'agy';
    const client = createLLMClient();
    expect(client).toBeDefined();
    delete process.env.LLM_PROVIDER;
    delete process.env.MOCK_GEMINI;
  });
});
