export interface RootCauseAnalysis { symptom: string; evidence: string[]; proximateCause?: string; rootCause?: string; contributingFactors: string[]; fix?: string; verification?: string; confidence: number; }
export function analyzeRootCause(input: Partial<RootCauseAnalysis>): RootCauseAnalysis {
  return { symptom: input.symptom ?? 'unknown failure', evidence: input.evidence ?? [], proximateCause: input.proximateCause, rootCause: input.rootCause, contributingFactors: input.contributingFactors ?? [], fix: input.fix, verification: input.verification, confidence: Math.max(0, Math.min(1, input.confidence ?? 0)) };
}
export function rootCausePrompt(problem: string): string { return `ROOT-CAUSE MODE\nProblem: ${problem}\nSeparate symptom from evidence, proximate cause, root cause, contributing factors, minimal fix, and verification. Do not call a guess a root cause.`; }
