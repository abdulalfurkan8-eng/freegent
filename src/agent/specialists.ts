export type Specialist = 'investigator'|'planner'|'coder'|'tester'|'security'|'performance'|'ux'|'skeptic'|'recovery';
export interface SpecialistTask { role: Specialist; objective: string; independent: boolean; }
export function specialistTasks(task: string): SpecialistTask[] {
  const base: SpecialistTask[] = [{role:'investigator',objective:`Find evidence and relevant code paths for: ${task}`,independent:true},{role:'planner',objective:`Design the smallest dependency-aware plan for: ${task}`,independent:true},{role:'tester',objective:`Identify tests and failure modes for: ${task}`,independent:true},{role:'skeptic',objective:`Try to disprove the proposed solution for: ${task}`,independent:true}];
  if (/security|auth|credential|permission|token/i.test(task)) base.push({role:'security',objective:`Find security risks in: ${task}`,independent:true});
  return base;
}
