import { MarketData } from './types.ts';

export function generateExtractionPrompt(analysis: string, watchlistData: MarketData[]): string {

  return `Find the "Proceed with full specialist analysis" section and extract the numbered stock list.

ANALYSIS TEXT:
${analysis}

TASK: Look for this EXACT section:
"Proceed with full specialist analysis on the following stocks (in priority order): 1) TICKER1 (...), 2) TICKER2 (...), 3) TICKER3 (...)"

EXTRACTION STEPS:
1. Find the section that starts with "Proceed with full specialist analysis"
2. Extract ONLY the numbered tickers from that list: 1) 2) 3) etc.
3. Assign priority based on the number: 1) = high, 2) = medium, 3) = low
4. Extract the reason from the parentheses after each ticker

EXAMPLE INPUT:
"Proceed with full specialist analysis on: 1) MU (near support with low RSI), 2) PDD (momentum near 52-week high), 3) AMD (strong 1M momentum)"

EXPECTED OUTPUT:
{
  "recommendAnalysis": true,
  "selectedStocks": [
    {"ticker": "MU", "reason": "near support with low RSI", "priority": "high", "signals": ["support", "low_rsi"]},
    {"ticker": "PDD", "reason": "momentum near 52-week high", "priority": "medium", "signals": ["momentum", "52w_high"]},
    {"ticker": "AMD", "reason": "strong 1M momentum", "priority": "low", "signals": ["momentum"]}
  ],
  "marketConditions": {"trend": "neutral", "volatility": "medium"}
}

CRITICAL: Only extract tickers from the numbered "Proceed with full specialist analysis" list. Ignore all other stock mentions.

Return ONLY valid JSON with no extra text:`;
}

export function generateOpportunityPrompt(
  portfolioData: any,
  watchlistData: MarketData[],
  marketRange: string
): string {
  const currentDate = new Date().toISOString().split('T')[0];

  // Calculate minimum stocks to recommend (30% of watchlist, min 1, max 8)
  const totalStocks = watchlistData?.length || 0;
  const minRecommendations = Math.max(1, Math.ceil(totalStocks * 0.3));
  const maxRecommendations = Math.min(8, Math.max(minRecommendations + 2, 5));

  // Create ticker list for the prompt
  const tickerList = watchlistData?.map(stock => stock.ticker).join(', ') || 'No stocks provided';

  // Calculate current allocations
  const currentAllocations: Record<string, number> = {};
  if (portfolioData && portfolioData.positions && Array.isArray(portfolioData.positions)) {
    const totalValue = portfolioData.totalValue || 1; // Avoid division by zero
    for (const position of portfolioData.positions) {
      if (position && position.ticker && position.value !== undefined) {
        const allocation = (position.value / totalValue) * 100;
        currentAllocations[position.ticker] = allocation;
      }
    }
  }

  // Identify high-signal stocks with less conservative thresholds
  const highSignalStocks = watchlistData.filter(stock => {
    const signals: string[] = [];

    // Price movement signals (lowered threshold)
    if (Math.abs(stock.dayChangePercent) > 3) signals.push('significant_price_move');
    if (Math.abs(stock.dayChangePercent) > 5) signals.push('large_price_move');

    // Volume signals (lowered threshold)
    if (stock.volume > stock.avgVolume * 1.5) signals.push('volume_increase');
    if (stock.volume > stock.avgVolume * 2) signals.push('volume_spike');

    // Technical signals (expanded range)
    if (stock.rsi && stock.rsi < 35) signals.push('oversold');
    if (stock.rsi && stock.rsi > 65) signals.push('overbought');
    if (stock.rsi && (stock.rsi < 30 || stock.rsi > 70)) signals.push('rsi_extreme');

    // 52-week range signals (expanded range)
    if (stock.currentPrice > stock.weekHigh * 0.95) signals.push('near_52w_high');
    if (stock.currentPrice < stock.weekLow * 1.05) signals.push('near_52w_low');

    // Volatility signals
    if (stock.volatility && stock.volatility > 0.25) signals.push('elevated_volatility');
    if (stock.volatility && stock.volatility > 0.4) signals.push('high_volatility');

    // Gap signals
    if (stock.open && stock.prevClose) {
      const gapPercent = Math.abs((stock.open - stock.prevClose) / stock.prevClose * 100);
      if (gapPercent > 1) signals.push('gap_open');
    }

    return signals.length >= 2; // At least 2 signals to be considered high-signal
  });

  return `You are acting as a Market Scanner and Opportunity Spotter. Your role is to quickly scan the provided market data and identify which stocks (if any) should be sent to our team of specialist agents for in-depth analysis.

Think of yourself as the first filter in a multi-stage analysis pipeline. Each stock you recommend will trigger detailed analysis by multiple specialist agents (technical analysts, fundamental analysts, sentiment analysts, etc.), which costs API resources. Therefore, be selective but not overly restrictive.

Current Date: ${currentDate}

Portfolio Overview:
- Total Value: $${(portfolioData?.totalValue || 0).toLocaleString()}
- Cash Available: $${(portfolioData?.cash || 0).toLocaleString()}
- Number of Positions: ${portfolioData?.positions?.length || 0}

Current Portfolio Allocations:
${Object.entries(currentAllocations).length > 0
      ? Object.entries(currentAllocations).map(([ticker, pct]) => `- ${ticker}: ${pct.toFixed(2)}%`).join('\n')
      : 'No current positions'}

Market Data Analysis Period: ${marketRange}

Market Data for Watchlist & Holdings (${watchlistData?.length || 0} total stocks):
${(watchlistData || []).map(stock => {
        let indicatorsSummary = '';
        
        // Add period metrics if available
        if (stock.periodReturn !== undefined) {
          indicatorsSummary += `\n  - ${marketRange} Return: ${stock.periodReturn.toFixed(2)}%`;
        }
        if (stock.periodAvgVolume !== undefined) {
          indicatorsSummary += `\n  - ${marketRange} Avg Volume: ${(stock.periodAvgVolume / 1000000).toFixed(2)}M`;
        }
        
        // Add technical indicators if available
        if (stock.indicators) {
          if (stock.indicators.sma20) indicatorsSummary += `\n  - SMA20: $${stock.indicators.sma20.toFixed(2)}`;
          if (stock.indicators.sma50) indicatorsSummary += `\n  - SMA50: $${stock.indicators.sma50.toFixed(2)}`;
          if (stock.indicators.bollingerBands) {
            indicatorsSummary += `\n  - BB: $${stock.indicators.bollingerBands.lower.toFixed(2)}-${stock.indicators.bollingerBands.upper.toFixed(2)}`;
          }
        }

        return `
${stock.ticker}:
  - Current Price: $${stock.currentPrice.toFixed(2)}
  - Day Change: ${stock.dayChangePercent.toFixed(2)}%
  - Volume: ${(stock.volume / 1000000).toFixed(2)}M (avg: ${(stock.avgVolume / 1000000).toFixed(2)}M)
  - 52W Range: $${stock.weekLow.toFixed(2)} - $${stock.weekHigh.toFixed(2)}
  ${stock.rsi ? `- RSI: ${stock.rsi.toFixed(1)}` : ''}
  ${stock.macd ? `- MACD: ${stock.macd}` : ''}
  ${stock.volatility ? `- Volatility: ${(stock.volatility * 100).toFixed(1)}%` : ''}${indicatorsSummary}`;
      }).join('\n')}

High-Signal Stocks Detected (${highSignalStocks.length}):
${highSignalStocks.length > 0
      ? highSignalStocks.map(stock => `- ${stock.ticker}: Day change ${stock.dayChangePercent.toFixed(2)}%, Volume ${(stock.volume / stock.avgVolume).toFixed(1)}x average`).join('\n')
      : 'No high-signal stocks detected'}

Market Opportunity Evaluation:
You are evaluating ${watchlistData?.length || 0} stocks for potential trading opportunities.

AVAILABLE STOCKS FOR ANALYSIS: [${tickerList}]
You MUST choose from ONLY these ${totalStocks} stocks listed above.

Current Portfolio Context:
- ${Object.keys(currentAllocations).length} existing positions
- Largest positions: ${Object.entries(currentAllocations)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([ticker, pct]) => `${ticker} (${pct.toFixed(1)}%)`)
      .join(', ') || 'None'}

YOUR SCANNING OBJECTIVE:
Quickly identify stocks that show interesting patterns worthy of deeper investigation by our specialist agents. You're looking for:

1. **Clear Opportunities**: Stocks showing strong technical setups, breakout patterns, or momentum shifts
2. **Risk Signals**: Existing positions showing concerning patterns that need immediate attention
3. **Unusual Activity**: Abnormal volume, price gaps, volatility spikes, or divergences from normal behavior
4. **Confluence of Factors**: Multiple indicators aligning to suggest something significant is happening
5. **Timely Setups**: Stocks at critical decision points (support/resistance, RSI extremes, pattern completions)

YOUR ANALYSIS APPROACH:
Scan the data like a radar system - quickly identify the most interesting signals from the noise. Consider:
- How each stock's current behavior compares to its recent history
- Whether technical indicators are showing extreme or interesting readings
- If volume patterns suggest institutional activity or retail interest
- Whether existing positions need risk management attention
- If any stocks are at critical technical levels

SELECTION CRITERIA:
- Choose AT LEAST ${minRecommendations} stocks from the provided list (${Math.round((minRecommendations / totalStocks) * 100)}% of ${totalStocks} total)
- Maximum ${maxRecommendations} stocks can be selected
- Each recommendation triggers ~6-8 specialist agents to analyze that stock
- Focus on stocks where deeper analysis could lead to actionable trading decisions
- Even if some stocks look neutral, select at least ${minRecommendations} that show the most interesting patterns
- Prioritize based on signal strength, but ensure minimum selection quota is met

OUTPUT FORMAT - CRITICAL:
You MUST write a natural language market commentary, NOT JSON or structured data.

Structure your response as a professional market report with these sections:

**Opening Market Assessment** (1-2 paragraphs)
Describe the overall market picture you're seeing. Are there broad themes? Is it a risk-on or risk-off environment? What's the general tone of the watchlist?

**Opportunity Identification** (2-3 paragraphs)
Discuss which stocks (if any) caught your attention and why. For each interesting stock, explain the specific signals or patterns that make it worth deeper investigation. Be specific about price levels, indicator readings, and volume patterns.

**Recommendation** (1 paragraph)
State your recommendations for which stocks should receive full specialist analysis. Use this EXACT format:
"Proceed with full specialist analysis on the following stocks (in priority order): 1) TICKER1 (reason), 2) TICKER2 (reason), 3) TICKER3 (reason)..." 
IMPORTANT: You MUST recommend AT LEAST ${minRecommendations} stocks from the provided list of [${tickerList}].
If recommending portfolio risk review separately, add: "Additionally, conduct immediate portfolio risk review on: TICKER4, TICKER5"

CRITICAL REQUIREMENTS:
- Select AT MINIMUM ${minRecommendations} stocks (this is ${Math.round((minRecommendations / totalStocks) * 100)}% of the ${totalStocks} stocks provided)
- Maximum ${maxRecommendations} stocks allowed
- ONLY select from: [${tickerList}]
- List each ticker explicitly - do not use vague language like "the stocks mentioned above"

REMEMBER: You are writing a market commentary report in plain English. No JSON, no bullet points, no structured data formats. Write in clear, professional prose as if briefing a trading desk about what deserves their attention today.`;
}