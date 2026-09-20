export interface AgentMetric { name:string; value:number; ts:string; }
const metrics:AgentMetric[]=[];
export function metric(name:string,value:number){metrics.push({name,value,ts:new Date().toISOString()});if(metrics.length>1000)metrics.shift();}
export function recentMetrics(){return metrics.slice(-100);}
