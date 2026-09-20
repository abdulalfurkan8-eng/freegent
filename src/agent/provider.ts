import type { Page } from 'playwright';
import {
  sendPrompt as sendGeminiPrompt,
  waitForCompleteResponse as waitForGeminiResponse,
  snapshotAssistant as snapshotGeminiAssistant,
} from '../browser/gemini.js';
import { sendPrompt, waitForCompleteResponse, snapshotAssistant } from '../browser/deepseek.js';

export interface LLMProvider {
  send(prompt: string, signal?: AbortSignal, images?: string[]): Promise<string>;
  close?(): Promise<void> | void;
}

export class BrowserLLMProvider implements LLMProvider {
  constructor(private readonly page: Page, private readonly idleMs = 2500, private readonly timeoutMs = 300000) {}
  async send(prompt: string, signal?: AbortSignal, _images?: string[]): Promise<string> {
    const before = await snapshotAssistant(this.page);
    await sendPrompt(this.page, prompt);
    return waitForCompleteResponse(this.page, this.idleMs, this.timeoutMs, before, signal);
  }
}

/** Gemini through the logged-in Gemini web app; no API key and no Developer API. */
export class BrowserGeminiLLMProvider implements LLMProvider {
  constructor(private readonly page: Page, private readonly idleMs = 2500, private readonly timeoutMs = 300000) {}
  async send(prompt: string, signal?: AbortSignal, images: string[] = []): Promise<string> {
    const before = await snapshotGeminiAssistant(this.page);
    await sendGeminiPrompt(this.page, prompt, images);
    return waitForGeminiResponse(this.page, this.idleMs, this.timeoutMs, before, signal);
  }
}
