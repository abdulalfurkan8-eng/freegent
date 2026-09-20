import type { ToolCall } from '../tools/types.js';
export type PermissionDecision = 'allow'|'confirm'|'deny';
export interface RiskAssessment { level:'low'|'medium'|'high'; decision:PermissionDecision; reason:string; }
export function assessRisk(call: ToolCall): RiskAssessment {
  const text = `${call.tool} ${String(call.action ?? '')} ${String(call.command ?? '')}`;
  if (call.tool === 'delete_file' || /rm\s+-rf|format\b|diskpart|reg\s+delete|shutdown|reboot/i.test(text)) return { level:'high', decision:'confirm', reason:'destructive or difficult-to-reverse operation' };
  if (/send|submit|purchase|payment|publish|credential|secret|password|token|external/i.test(text)) return { level:'high', decision:'confirm', reason:'external side effect or sensitive data' };
  if (['write_file','edit_file','append_file','computer','windows','run_command','shell','git'].includes(call.tool)) return { level:'medium', decision:'allow', reason:'mutating or externally observable operation' };
  return { level:'low', decision:'allow', reason:'read-only operation' };
}
