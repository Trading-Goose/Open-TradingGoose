/**
 * Alpaca Portfolio API utilities for Supabase Edge Functions
 * Provides functions to fetch account info, positions, and calculate position sizing
 */

export interface AlpacaAccount {
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  portfolio_value: string;
  cash: string;
  long_market_value: string;
  equity: string;
  last_equity: string;
  multiplier: string;
  daytrading_buying_power: string;
  sma: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  qty_available: string;
  market_value: string;
  avg_entry_price: string;
  side: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface AlpacaQuote {
  symbol: string;
  ask_price: number;
  ask_size: number;
  bid_price: number;
  bid_size: number;
  last_price: number;
}

export interface PositionSizeRecommendation {
  ticker: string;
  currentPrice: number;
  portfolioValue: number;
  buyingPower: number;
  existingPosition?: {
    shares: number;
    marketValue: number;
    avgPrice: number;
  };
  recommendations: {
    conservative: {
      shares: number;
      dollarAmount: number;
      percentOfPortfolio: number;
      reasoning: string;
    };
    moderate: {
      shares: number;
      dollarAmount: number;
      percentOfPortfolio: number;
      reasoning: string;
    };
    aggressive: {
      shares: number;
      dollarAmount: number;
      percentOfPortfolio: number;
      reasoning: string;
    };
  };
}

/**
 * Fetch Alpaca account information
 */
export async function fetchAlpacaAccount(
  apiKey: string,
  secretKey: string,
  paper: boolean = true
): Promise<AlpacaAccount | null> {
  try {
    const baseUrl = paper 
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    
    console.log(`📡 Fetching Alpaca account from ${paper ? 'PAPER' : 'LIVE'} API: ${baseUrl}/v2/account`);
    
    const response = await fetch(`${baseUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Failed to fetch Alpaca account (${response.status}):`, errorText);
      return null;
    }
    
    const account = await response.json();
    console.log(`✅ Fetched Alpaca ${paper ? 'PAPER' : 'LIVE'} account:`);
    console.log(`  Account Number: ${account.account_number}`);
    console.log(`  Portfolio Value: $${account.portfolio_value}`);
    console.log(`  Cash: $${account.cash}`);
    console.log(`  Equity: $${account.equity}`);
    return account;
  } catch (error) {
    console.error('Error fetching Alpaca account:', error);
    return null;
  }
}

/**
 * Fetch all positions from Alpaca account
 */
export async function fetchAlpacaPositions(
  apiKey: string,
  secretKey: string,
  paper: boolean = true
): Promise<AlpacaPosition[]> {
  try {
    const baseUrl = paper 
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    
    console.log(`📡 Fetching positions from ${paper ? 'PAPER' : 'LIVE'} API: ${baseUrl}/v2/positions`);
    
    const response = await fetch(`${baseUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Failed to fetch Alpaca positions (${response.status}):`, errorText);
      
      // Check for specific error codes
      if (response.status === 401) {
        console.error('🔐 Authentication failed - check API keys');
        console.error(`  Used API Key: ${apiKey.substring(0, 8)}...`);
      } else if (response.status === 403) {
        console.error('🚫 Forbidden - check if using correct account type (paper vs live)');
        console.error(`  Tried to access: ${paper ? 'PAPER' : 'LIVE'} account`);
      } else if (response.status === 404) {
        console.error('❓ Endpoint not found - check API URL');
        console.error(`  URL: ${baseUrl}/v2/positions`);
      }
      
      // Don't silently return empty array on error - this masks the problem
      console.error('⚠️ Returning empty positions array due to API error - this may not reflect actual positions!');
      return [];
    }
    
    const positions = await response.json();
    console.log(`✅ API returned ${positions.length} positions from Alpaca ${paper ? 'PAPER' : 'LIVE'} account`);
    
    if (positions.length === 0) {
      console.log('📭 No positions found in account. Possible reasons:');
      console.log('  1. Account has no open positions (all cash)');
      console.log('  2. Wrong account type (paper vs live)');
      console.log(`  3. Current setting: ${paper ? 'PAPER' : 'LIVE'} trading`);
      console.log(`  4. API endpoint: ${baseUrl}/v2/positions`);
    } else {
      console.log('📊 Positions found:');
      positions.forEach((pos: AlpacaPosition, idx: number) => {
        if (idx < 5 || positions.length <= 6) {
          console.log(`  ${idx + 1}. ${pos.symbol}: ${pos.qty} shares @ avg $${pos.avg_entry_price}, current $${pos.current_price || pos.market_value}`);
        }
      });
      if (positions.length > 6) {
        console.log(`  ... and ${positions.length - 5} more positions`);
      }
    }
    return positions;
  } catch (error) {
    console.error('Error fetching Alpaca positions:', error);
    return [];
  }
}

/**
 * Fetch a specific position from Alpaca account
 */
export async function fetchAlpacaPosition(
  ticker: string,
  apiKey: string,
  secretKey: string,
  paper: boolean = true
): Promise<AlpacaPosition | null> {
  try {
    const baseUrl = paper 
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    
    const response = await fetch(`${baseUrl}/v2/positions/${ticker}`, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
      }
    });
    
    if (response.status === 404) {
      console.log(`No existing position for ${ticker}`);
      return null;
    }
    
    if (!response.ok) {
      console.error('Failed to fetch position:', await response.text());
      return null;
    }
    
    const position = await response.json();
    console.log(`✅ Fetched position for ${ticker}: ${position.qty} shares @ $${position.avg_entry_price}`);
    return position;
  } catch (error) {
    console.error('Error fetching position:', error);
    return null;
  }
}

/**
 * Get current market quote for a ticker
 */
export async function fetchAlpacaQuote(
  ticker: string,
  apiKey: string,
  secretKey: string
): Promise<AlpacaQuote | null> {
  try {
    const baseUrl = 'https://data.alpaca.markets';
    
    const response = await fetch(`${baseUrl}/v2/stocks/${ticker}/quotes/latest`, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
      }
    });
    
    if (!response.ok) {
      console.error('Failed to fetch quote:', await response.text());
      return null;
    }
    
    const data = await response.json();
    const quote = data.quote;
    
    return {
      symbol: ticker,
      ask_price: quote.ap || quote.ask_price,
      ask_size: quote.as || quote.ask_size,
      bid_price: quote.bp || quote.bid_price,
      bid_size: quote.bs || quote.bid_size,
      last_price: (quote.ap + quote.bp) / 2 || quote.ap || quote.bp
    };
  } catch (error) {
    console.error('Error fetching quote:', error);
    return null;
  }
}

/**
 * Calculate position size recommendations based on portfolio and risk parameters
 */
export function calculatePositionSizing(
  ticker: string,
  currentPrice: number,
  account: AlpacaAccount,
  existingPosition: AlpacaPosition | null,
  confidence: number,
  riskScore: number
): PositionSizeRecommendation {
  const portfolioValue = parseFloat(account.portfolio_value);
  const buyingPower = parseFloat(account.buying_power);
  const cash = parseFloat(account.cash);
  
  // Base position sizes as percentage of portfolio
  let conservativePercent = 1; // 1% for very conservative
  let moderatePercent = 3;     // 3% for moderate
  let aggressivePercent = 5;   // 5% for aggressive
  
  // Adjust based on confidence (60-100 scale)
  const confidenceMultiplier = 0.5 + ((confidence - 60) / 40) * 0.5; // 0.5 to 1.0
  
  // Adjust based on risk score (1-10 scale, lower is better)
  const riskMultiplier = riskScore <= 3 ? 1.2 : 
                         riskScore <= 5 ? 1.0 :
                         riskScore <= 7 ? 0.8 : 0.6;
  
  // Calculate final percentages
  conservativePercent *= confidenceMultiplier * riskMultiplier;
  moderatePercent *= confidenceMultiplier * riskMultiplier;
  aggressivePercent *= confidenceMultiplier * riskMultiplier;
  
  // Cap at maximum safe levels
  conservativePercent = Math.min(conservativePercent, 2);
  moderatePercent = Math.min(moderatePercent, 5);
  aggressivePercent = Math.min(aggressivePercent, 10);
  
  // Calculate dollar amounts
  const conservativeDollars = portfolioValue * (conservativePercent / 100);
  const moderateDollars = portfolioValue * (moderatePercent / 100);
  const aggressiveDollars = portfolioValue * (aggressivePercent / 100);
  
  // Ensure we don't exceed buying power
  const maxDollars = Math.min(buyingPower, cash * 0.9); // Leave 10% cash buffer
  
  // Calculate shares (round down to whole shares)
  const conservativeShares = Math.floor(Math.min(conservativeDollars, maxDollars) / currentPrice);
  const moderateShares = Math.floor(Math.min(moderateDollars, maxDollars) / currentPrice);
  const aggressiveShares = Math.floor(Math.min(aggressiveDollars, maxDollars) / currentPrice);
  
  // Build recommendation object
  const recommendation: PositionSizeRecommendation = {
    ticker,
    currentPrice,
    portfolioValue,
    buyingPower,
    recommendations: {
      conservative: {
        shares: conservativeShares,
        dollarAmount: conservativeShares * currentPrice,
        percentOfPortfolio: (conservativeShares * currentPrice / portfolioValue) * 100,
        reasoning: `Conservative ${conservativePercent.toFixed(1)}% position for risk-averse investors. ` +
                  `Confidence: ${confidence}%, Risk Score: ${riskScore}/10`
      },
      moderate: {
        shares: moderateShares,
        dollarAmount: moderateShares * currentPrice,
        percentOfPortfolio: (moderateShares * currentPrice / portfolioValue) * 100,
        reasoning: `Moderate ${moderatePercent.toFixed(1)}% position for balanced risk-reward. ` +
                  `Confidence: ${confidence}%, Risk Score: ${riskScore}/10`
      },
      aggressive: {
        shares: aggressiveShares,
        dollarAmount: aggressiveShares * currentPrice,
        percentOfPortfolio: (aggressiveShares * currentPrice / portfolioValue) * 100,
        reasoning: `Aggressive ${aggressivePercent.toFixed(1)}% position for high conviction trades. ` +
                  `Confidence: ${confidence}%, Risk Score: ${riskScore}/10`
      }
    }
  };
  
  // Add existing position info if available
  if (existingPosition) {
    recommendation.existingPosition = {
      shares: parseFloat(existingPosition.qty),
      marketValue: parseFloat(existingPosition.market_value),
      avgPrice: parseFloat(existingPosition.avg_entry_price)
    };
  }
  
  return recommendation;
}

/**
 * Format portfolio status for AI analysis
 */
export function formatPortfolioForAnalysis(
  account: AlpacaAccount,
  positions: AlpacaPosition[]
): string {
  const portfolioValue = parseFloat(account.portfolio_value);
  const cash = parseFloat(account.cash);
  const buyingPower = parseFloat(account.buying_power);
  
  let summary = `📊 Portfolio Status:\n`;
  summary += `  - Total Value: $${portfolioValue.toLocaleString()}\n`;
  summary += `  - Cash Available: $${cash.toLocaleString()}\n`;
  summary += `  - Buying Power: $${buyingPower.toLocaleString()}\n`;
  summary += `  - Number of Positions: ${positions.length}\n`;
  
  if (positions.length > 0) {
    summary += `\n📈 Current Positions:\n`;
    
    // Sort by market value descending
    const sortedPositions = [...positions].sort((a, b) => 
      parseFloat(b.market_value) - parseFloat(a.market_value)
    );
    
    // Show top 10 positions
    sortedPositions.slice(0, 10).forEach(pos => {
      const marketValue = parseFloat(pos.market_value);
      const unrealizedPL = parseFloat(pos.unrealized_pl);
      const plPercent = parseFloat(pos.unrealized_plpc) * 100;
      const portfolioPercent = (marketValue / portfolioValue) * 100;
      
      summary += `  - ${pos.symbol}: ${pos.qty} shares @ $${pos.current_price}\n`;
      summary += `    Value: $${marketValue.toLocaleString()} (${portfolioPercent.toFixed(1)}% of portfolio)\n`;
      summary += `    P/L: ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(2)} (${plPercent >= 0 ? '+' : ''}${plPercent.toFixed(2)}%)\n`;
    });
    
    if (positions.length > 10) {
      summary += `  ... and ${positions.length - 10} more positions\n`;
    }
  }
  
  // Calculate portfolio metrics
  const cashPercent = (cash / portfolioValue) * 100;
  const investedPercent = 100 - cashPercent;
  
  summary += `\n💰 Allocation:\n`;
  summary += `  - Invested: ${investedPercent.toFixed(1)}%\n`;
  summary += `  - Cash: ${cashPercent.toFixed(1)}%\n`;
  
  return summary;
}