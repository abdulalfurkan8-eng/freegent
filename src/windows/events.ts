export interface WindowEvent { type:'foreground'|'created'|'closed'|'changed'; title:string; ts:string; }
export function classifyWindowChange(previous:string|undefined,current:string|undefined): WindowEvent|null { if(previous===current) return null; return {type:'foreground',title:current??'',ts:new Date().toISOString()}; }
