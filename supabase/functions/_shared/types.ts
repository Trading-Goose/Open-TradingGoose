export interface AgentRequest {
  analysisId: string;
  ticker: string;
  userId: string;
  apiSettings: {
    ai_provider: string;
    ai_api_key: string;
    ai_model?: string;
    analysis_depth?: string;
    analysis_history_days?: number;
    research_debate_rounds?: number;
    analysis_max_tokens?: number;
    research_max_tokens?: number;
    trading_max_tokens?: number;
    risk_max_tokens?: number;
  };
  analysisContext?: {
    type: 'individual';
    skipTradeOrders?: boolean;
  };
  context?: {
    messages: any[];
    workflowSteps: any[];
  };
  _retry?: {
    attempt: number;           // Current retry attempt (0 = first try)
    maxRetries: number;        // Maximum retries allowed
    timeoutMs: number;         // Timeout per attempt in milliseconds
    originalStartTime: string; // ISO timestamp of first invocation
    functionName: string;      // Agent function name for self-invocation
  };
}



export function getHistoryDays(apiSettings: AgentRequest['apiSettings']): number {
  return apiSettings.analysis_history_days || 30;
}

export function getDebateRounds(apiSettings: AgentRequest['apiSettings']): number {
  return apiSettings.research_debate_rounds || 2;
}

