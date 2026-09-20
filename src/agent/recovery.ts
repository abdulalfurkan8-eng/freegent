export type RecoveryStep = 'retry'|'reobserve'|'refind'|'alternate'|'restart'|'rollback'|'replan'|'ask';
export interface RecoveryOptions { taskType?: string; custom?: RecoveryStep[]; }
const defaults: Record<string, RecoveryStep[]> = {
  gui:['reobserve','refind','alternate','replan','ask'], coding:['retry','reobserve','alternate','replan'], destructive:['rollback','replan','ask'], default:['retry','reobserve','alternate','replan']
};
export function recoveryPlan(failures:number,sameFailure:number, options:RecoveryOptions={}):RecoveryStep[]{ if(options.custom?.length)return [...options.custom]; const base=defaults[options.taskType??'default']??defaults.default; if(sameFailure>=2)return ['reobserve','refind','alternate','replan','ask']; if(failures>=3)return ['reobserve','alternate','rollback','replan','ask']; return [...base]; }
