export interface ContextItem { text:string; source:string; score:number; tokens:number; }
export function buildRelevantContext(items: ContextItem[], budget=6000): string {
  let used=0; const out:string[]=[];
  for (const x of [...items].sort((a,b)=>b.score-a.score)) { if (used+x.tokens>budget) continue; out.push(`[${x.source}] ${x.text}`); used+=x.tokens; }
  return out.join('\n');
}
