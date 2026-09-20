/** Compatibility facade. security/permissions.ts is the canonical security boundary. */
export { assessRisk } from '../security/permissions.js';
export type { PermissionDecision, RiskAssessment } from '../security/permissions.js';
