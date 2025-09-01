// Types for the analysis-coordinator function

export interface CorsHeaders {
  'Access-Control-Allow-Origin': string;
  'Access-Control-Allow-Headers': string;
  'Content-Type'?: string;
}

export interface ApiSettings {
  ai_provider: string;
  ai_api_key: string;
  ai_model: string;
  // Alpaca credentials
  alpaca_paper_api_key?: string;
  alpaca_paper_secret_key?: string;
  alpaca_live_api_key?: string;
  alpaca_live_secret_key?: string;
  alpaca_paper_trading?: boolean;
  // User preferences
  user_risk_level?: string;
  default_position_size_dollars?: number;
  analysis_depth?: string;
  analysis_history_days?: number;
  research_debate_rounds?: number;
  // Max tokens settings
  analysis_max_tokens?: number;
  research_max_tokens?: number;
  trading_max_tokens?: number;
  risk_max_tokens?: number;
  // Portfolio Manager settings
  portfolio_manager_ai?: string;
  portfolio_manager_model?: string;
  portfolio_manager_max_tokens?: number;
}

export interface AnalysisContext {
  type: 'individual';
  tickerIndex?: number;
  totalTickers?: number;
  portfolioData?: PortfolioData;
  source?: 'risk-completion' | 'direct';
  // Retry mode fields removed - retry-handler now directly invokes failed agents
}

export interface PortfolioData {
  account?: {
    buying_power: string;
    portfolio_value: string;
    cash: string;
    equity: string;
  };
  positions?: Array<{
    symbol?: string;
    ticker?: string;
    qty?: string;
    shares?: number;
    market_value?: string;
    value?: number;
    avg_entry_price?: string;
    avgPrice?: number;
    unrealized_pl?: string;
    unrealizedPL?: number;
    unrealized_plpc?: string;
    unrealizedPLPercent?: number;
    current_price?: string;
    currentPrice?: number;
    costBasis?: number;
    dayChangePercent?: number;
    priceChangeFromAvg?: number;
  }>;
  totalValue?: number;
  cash?: number;
  cashBalance?: number;
  currentAllocations?: Record<string, number>;
}

export interface CancellationCheckResult {
  isCanceled: boolean;
  shouldContinue: boolean;
  reason?: string;
}

export interface WorkflowPhase {
  agents: string[];
  nextPhase?: string;
  finalAgent?: string | null;
}

export interface WorkflowPhases {
  [key: string]: WorkflowPhase;
}

export interface RequestBody {
  action?: string;
  analysisId?: string;
  ticker?: string;
  userId?: string;
  phase?: string;
  agent?: string;
  analysisContext?: AnalysisContext;
  useDefaultSettings?: boolean;
  error?: string;
  errorType?: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'other';
  completionType?: 'normal' | 'last_in_phase' | 'fallback_invocation_failed';
  failedToInvoke?: string;
  riskManagerDecision?: any;
}