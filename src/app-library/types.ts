export type ProfileStatus = 'builtin' | 'verified' | 'stale' | 'failed';

export interface AppMatch {
  processes: string[];
  windowTitles: string[];
  taskKeywords: string[];
}

export interface AppWorkflow {
  name: string;
  purpose: string;
  steps: string[];
  verify: string[];
  status: ProfileStatus;
}

export interface AppProfileMatch {
  profile: AppProfile;
  score: number;
  confidence: number;
}

export interface AppProfile {
  id: string;
  name: string;
  description: string;
  match: AppMatch;
  prerequisites: string[];
  shortcuts: Record<string, string>;
  regions: string[];
  workflows: AppWorkflow[];
  warnings: string[];
  versionHints: string[];
  status: ProfileStatus;
  updatedAt: string;
}

export interface ActiveWindowLike {
  process?: string;
  title?: string;
}
