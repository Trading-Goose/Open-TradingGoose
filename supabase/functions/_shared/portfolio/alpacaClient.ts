/**
 * Shared Alpaca portfolio client for portfolio management functions
 * Extracted from duplicate code in analysis-portfolio-manager
 */

import { AlpacaPortfolioData } from './types.ts';
import { extractAlpacaCredentials, createAlpacaHeaders } from './config.ts';

// Legacy portfolio data format for backward compatibility
export interface LegacyPortfolioData {
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

/**
 * Fetch complete portfolio data from Alpaca API
 * Includes account information, positions, and open orders with reserved capital calculations
 */
export async function fetchAlpacaPortfolio(apiSettings: any): Promise<AlpacaPortfolioData> {
  const { apiKey, secretKey, baseUrl, isPaperTrading } = extractAlpacaCredentials(apiSettings);
  const headers = createAlpacaHeaders(apiKey, secretKey);

  try {
    console.log('📊 Fetching Alpaca account from:', baseUrl);
    console.log('📊 Using paper trading:', isPaperTrading);
    console.log('📊 API Key present:', !!apiKey);
    console.log('📊 Secret Key present:', !!secretKey);
    
    // Fetch account data
    const accountResponse = await fetch(`${baseUrl}/v2/account`, { headers });
    if (!accountResponse.ok) {
      const errorText = await accountResponse.text();
      console.error('❌ Alpaca API error response:', {
        status: accountResponse.status,
        statusText: accountResponse.statusText,
        body: errorText
      });
      throw new Error(`Alpaca account fetch failed: ${accountResponse.status} ${accountResponse.statusText}`);
    }
    const account = await accountResponse.json();

    // Fetch positions
    const positionsResponse = await fetch(`${baseUrl}/v2/positions`, { headers });
    if (!positionsResponse.ok) {
      throw new Error(`Alpaca positions fetch failed: ${positionsResponse.statusText}`);
    }
    const positions = await positionsResponse.json();

    // Fetch open orders
    const ordersResponse = await fetch(`${baseUrl}/v2/orders?status=open`, { headers });
    if (!ordersResponse.ok) {
      console.warn('⚠️ Failed to fetch open orders, continuing without them');
    }
    const openOrders = ordersResponse.ok ? await ordersResponse.json() : [];
    
    // Calculate reserved capital from pending orders
    let reservedCapital = 0;
    const pendingOrders = openOrders.map((order: any) => {
      let orderReservedAmount = 0;
      
      if (order.side === 'buy') {
        if (order.notional) {
          orderReservedAmount = parseFloat(order.notional);
        } else if (order.qty && order.limit_price) {
          orderReservedAmount = parseFloat(order.qty) * parseFloat(order.limit_price);
        } else if (order.qty && order.type === 'market') {
          const position = positions.find((p: any) => p.symbol === order.symbol);
          const estimatedPrice = position?.current_price || position?.lastday_price || 0;
          orderReservedAmount = parseFloat(order.qty) * estimatedPrice * 1.02; // 2% buffer
        }
        reservedCapital += orderReservedAmount;
      }
      
      return {
        symbol: order.symbol,
        side: order.side,
        qty: parseFloat(order.qty || 0),
        notional: parseFloat(order.notional || 0),
        type: order.type,
        status: order.status,
        submitted_at: order.submitted_at,
        limit_price: order.limit_price ? parseFloat(order.limit_price) : null,
        reservedCapital: orderReservedAmount
      };
    });
    
    const adjustedCash = Math.max(0, parseFloat(account.cash) - reservedCapital);
    
    console.log(`📊 Open orders found: ${openOrders.length}`);
    console.log(`💰 Reserved capital from pending orders: $${reservedCapital.toFixed(2)}`);
    console.log(`💵 Adjusted available cash: $${adjustedCash.toFixed(2)} (original: $${account.cash})`);

    return {
      account: {
        buying_power: parseFloat(account.buying_power),
        original_buying_power: parseFloat(account.buying_power),
        cash: adjustedCash,
        original_cash: parseFloat(account.cash),
        portfolio_value: parseFloat(account.portfolio_value),
        long_market_value: parseFloat(account.long_market_value),
        equity: parseFloat(account.equity),
        day_trade_count: account.daytrade_count,
        pattern_day_trader: account.pattern_day_trader,
        reserved_capital: reservedCapital
      },
      positions: positions.map((p: any) => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        avg_entry_price: parseFloat(p.avg_entry_price),
        current_price: parseFloat(p.current_price || p.lastday_price),
        market_value: parseFloat(p.market_value),
        unrealized_pl: parseFloat(p.unrealized_pl),
        unrealized_plpc: parseFloat(p.unrealized_plpc)
      })),
      openOrders: pendingOrders
    };
  } catch (error) {
    console.error('❌ Failed to fetch Alpaca portfolio:', error);
    throw error;
  }
}

/**
 * Legacy adapter function for backward compatibility with deprecated coordinator
 * Converts new AlpacaPortfolioData format to legacy PortfolioData format
 */
export async function fetchAlpacaPortfolioData(apiSettings: any): Promise<LegacyPortfolioData | null> {
  try {
    console.log('🔄 Fetching portfolio data using legacy adapter');
    
    const portfolioData = await fetchAlpacaPortfolio(apiSettings);
    
    // Convert to legacy format
    const legacyData: LegacyPortfolioData = {
      totalValue: portfolioData.account.portfolio_value,
      cash: portfolioData.account.cash,
      cashBalance: portfolioData.account.cash,
      account: {
        buying_power: portfolioData.account.buying_power.toString(),
        portfolio_value: portfolioData.account.portfolio_value.toString(),
        cash: portfolioData.account.cash.toString(),
        equity: portfolioData.account.equity.toString()
      },
      positions: portfolioData.positions.map(pos => {
        const costBasis = pos.qty * pos.avg_entry_price;
        const priceChangeFromAvg = pos.current_price > 0 && pos.avg_entry_price > 0 
          ? ((pos.current_price - pos.avg_entry_price) / pos.avg_entry_price) * 100
          : 0;
        
        return {
          ticker: pos.symbol,
          symbol: pos.symbol,
          shares: pos.qty,
          qty: pos.qty.toString(),
          value: pos.market_value,
          market_value: pos.market_value.toString(),
          avgPrice: pos.avg_entry_price,
          avg_entry_price: pos.avg_entry_price.toString(),
          currentPrice: pos.current_price,
          current_price: pos.current_price.toString(),
          unrealizedPL: pos.unrealized_pl,
          unrealized_pl: pos.unrealized_pl.toString(),
          unrealizedPLPercent: pos.unrealized_plpc * 100,
          unrealized_plpc: pos.unrealized_plpc.toString(),
          costBasis,
          priceChangeFromAvg,
          dayChangePercent: 0 // Not available in new format, set to 0
        };
      })
    };
    
    console.log(`✅ Legacy adapter: ${legacyData.positions?.length || 0} positions, total value: $${legacyData.totalValue?.toLocaleString()}`);
    
    return legacyData;
  } catch (error) {
    console.error('❌ Legacy adapter failed:', error);
    return null;
  }
}