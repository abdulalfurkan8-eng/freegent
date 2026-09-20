import type { Page } from 'playwright';
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