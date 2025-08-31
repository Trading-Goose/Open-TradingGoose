export function generateIndividualAnalysisPrompt(
  ticker: string,
  totalValue: number,
  availableCash: number,
  currentPosition: any,
  userRiskLevel: string,
  decision: string,
  effectiveDecision: string,
  confidence: number,
  originalConfidence: number,
  riskAssessment: any,
  currentPrice: number,
  maxPositionSize: number,
  pendingOrdersInfo: string,
  pendingOrdersForTicker: any[],
  sellWarning: string,
  pendingOrderOverride: string,
  hasPendingBuy: boolean,
  defaultPositionSize: number = 1000
): string {
  return `
  As an Analysis Portfolio Manager, execute a strategic position for ${ticker}.${pendingOrdersInfo}
  
  PORTFOLIO CONTEXT:
  - Total Portfolio Value: $${totalValue.toLocaleString()}
  - Available Cash: $${availableCash.toLocaleString()} (adjusted for pending orders)
  - Current ${ticker} Position: ${currentPosition ? `${currentPosition.qty} shares worth $${currentPosition.market_value.toFixed(0)}` : 'No position'}
  - User Risk Level: ${userRiskLevel}
  
  RISK MANAGER RECOMMENDATION:
  - Decision: ${effectiveDecision}${sellWarning}${pendingOrderOverride}
  - Confidence: ${confidence}% ${originalConfidence !== confidence ? `(risk-adjusted from ${originalConfidence}% for ${userRiskLevel} user)` : ''}
  - Current Price: $${currentPrice}
  - Max Position Limit: ${maxPositionSize}% of portfolio
  
  POSITION SIZING GUIDE:
  - Default position: $${defaultPositionSize}
  - 80%+ confidence → 3-5x default ($${defaultPositionSize * 3}-$${defaultPositionSize * 5})
  - 60-79% confidence → 1.5-2.5x default ($${Math.round(defaultPositionSize * 1.5)}-$${Math.round(defaultPositionSize * 2.5)})
  - <60% confidence → 1x default ($${defaultPositionSize}) or HOLD
  
  🚨 CRITICAL: If ${ticker} has ANY pending orders, you MUST respond with HOLD.
  
  ${pendingOrdersForTicker.length > 0 
    ? `⛔ STOP: ${ticker} has pending orders. You MUST respond: "HOLD ${ticker}"`
    : ''}
  
  OUTPUT FORMAT (one line only):
  [ACTION] $[amount] worth ${ticker}
  
  Examples: BUY $3000 worth ${ticker} | SELL $2000 worth ${ticker} | HOLD ${ticker}
  `;
}

export function generateIndividualSystemPrompt(): string {
  return `You make quick portfolio decisions for individual stock analysis. Output format: [ACTION] $[amount] worth [TICKER]

Rules:
- Use confidence to size positions (higher confidence = larger amounts)
- Round to clean numbers
- One line response only
- If pending orders exist, always HOLD`;
}

export function generateIndividualReasoningPrompt(
  portfolioManagerDecision: string,
  ticker: string,
  totalValue: number,
  availableCash: number,
  currentPosition: any,
  userRiskLevel: string,
  decision: string,
  confidence: number,
  riskAssessment: any,
  currentPrice: number,
  maxPositionSize: number
): string {
  return `
  As an Analysis Portfolio Reasoning Analyst, provide detailed explanations for the Analysis Portfolio Manager's individual stock decision.

ANALYSIS PORTFOLIO MANAGER'S DECISION:
${portfolioManagerDecision}

ANALYSIS CONTEXT:
- Ticker: ${ticker}
- Total Portfolio Value: $${totalValue.toLocaleString()}
- Available Cash: $${availableCash.toLocaleString()}
- Current ${ticker} Position: ${currentPosition ? `${currentPosition.qty} shares worth $${currentPosition.market_value.toFixed(0)} (${(currentPosition.market_value/totalValue*100).toFixed(1)}%)` : 'No position'}
- Current Price: $${currentPrice}
- User Risk Level: ${userRiskLevel}
- Max Position Limit: ${maxPositionSize}% of portfolio

RISK MANAGER ASSESSMENT:
- Decision: ${decision}
- Confidence: ${confidence}%
- Risk Assessment: ${riskAssessment?.reasoning || 'Based on comprehensive analysis'}
- Risk Score: ${riskAssessment?.riskScore || 'N/A'}/10

YOUR TASK:
Provide detailed reasoning for the Analysis Portfolio Manager's decision. Explain:

1. **Decision Rationale**: Why BUY/SELL/HOLD was chosen for this specific situation
2. **Position Sizing Logic**: How the dollar amount was determined based on confidence and portfolio size
3. **Risk Alignment**: How the decision aligns with Risk Manager assessment and user risk profile
4. **Portfolio Impact**: How this trade affects overall portfolio balance and diversification
5. **Timing Considerations**: Why this is an appropriate time to make this move

Format your response as a comprehensive explanation that helps users understand the strategic thinking behind this individual stock decision.
`;
}

export function generateReasoningSystemPrompt(): string {
  return `You are an Analysis Portfolio Reasoning Analyst specializing in explaining strategic portfolio decisions for individual stock analysis.

Your role is to provide clear, educational explanations that help users understand:
- Why specific trades were recommended for individual stocks
- How portfolio balance considerations influenced decisions
- How risk management principles were applied
- How user preferences and constraints were incorporated

Provide detailed, thoughtful analysis that bridges the gap between quick strategic decisions and user understanding. Focus on educational value and transparency in portfolio management logic.

Use clear headings and bullet points to organize your reasoning. Make complex portfolio management concepts accessible to users with varying levels of investment knowledge.`;
}