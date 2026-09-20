export type Strategy = 'semantic-ui'|'keyboard'|'ocr'|'vision-mouse'|'terminal'|'application-automation';

export interface StrategyScore { strategy: Strategy; score: number; reason: string; }

/** Deterministic first-pass strategy selector; the model remains responsible for task semantics. */
export function rankStrategies(task: string): StrategyScore[] {
  const t = task.toLowerCase();
  const simpleComputer = /^(please\s+)?(?:open\s+(?:vs code|visual studio code|notepad|calculator|calc|paint|blender)\s*[.!?]?|type\s*[:=-]\s*.+|press\s+.+)$/i.test(t);
  const gui = /(click|open|drag|select|menu|dialog|window|blender|photoshop|premiere|excel|unity|cad|browser|visual)/.test(t);
  const code = /(bug|fix|refactor|compile|test|implement|function|class|typescript|javascript|python|java|code)/.test(t);
  const research = /(latest|current|documentation|docs|research|version|release)/.test(t);
  const scores: StrategyScore[] = [
    { strategy:'semantic-ui', score: simpleComputer ? 0.99 : gui ? 0.95 : 0.35, reason:'Reliable semantic interaction when an application exposes accessibility information.' },
    { strategy:'keyboard', score: gui ? 0.88 : 0.25, reason:'Fast deterministic interaction for complex desktop applications.' },
    { strategy:'ocr', score: gui ? 0.78 : 0.15, reason:'Useful when visible text is the strongest target signal.' },
    { strategy:'vision-mouse', score: gui ? 0.72 : 0.12, reason:'Fallback for custom-rendered controls without reliable UI semantics.' },
    { strategy:'application-automation', score: code ? 0.55 : 0.45, reason:'Use only when explicitly requested or the visible UI cannot accomplish the task.' },
    { strategy:'terminal', score: code ? 0.82 : (research ? 0.52 : 0.2), reason:'Efficient for repository inspection, builds, tests, and system tasks.' },
  ];
  return scores.sort((a,b) => b.score - a.score);
}

export function strategyPrompt(task: string): string {
  const ranked = rankStrategies(task).map((s, i) => `${i + 1}. ${s.strategy} (${s.score.toFixed(2)}): ${s.reason}`).join('\n');
  return `STRATEGY HINTS (runtime heuristic; use evidence to override):\n${ranked}`;
}
