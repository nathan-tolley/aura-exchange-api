export type Role = "OWNER" | "MODERATOR" | "MEMBER";
export type TradeSide = "BUY" | "SELL" | "SHORT" | "COVER";
export type AuraVerdict = "GAIN" | "LOSS" | "NEUTRAL" | "REVIEW";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  stockId: string | null;
  displayName: string | null;
  ticker: string | null;
  csrfToken: string;
}

export interface AuraJudgeInput {
  subjectKey: string;
  explanation: string;
  glossary: Array<{ phrase: string; explanation: string }>;
}

export interface AuraJudgeResult {
  verdict: AuraVerdict;
  delta: number;
  confidence: number;
  rationale: string;
  category: string;
  policyFlags: string[];
  provider: string;
  model: string;
  requestId?: string;
}

export interface AuraJudge {
  judge(input: AuraJudgeInput): Promise<AuraJudgeResult>;
}

