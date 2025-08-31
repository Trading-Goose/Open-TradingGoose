import { TradeOrderData } from '../../_shared/tradeOrders.ts';
import { IndividualAnalysisContext, PositionContext } from './individual-types.ts';

export async function prepareUserSettings(
  context: IndividualAnalysisContext
) {
  const { supabase, userId, apiSettings, constraints, portfolioData } = context;
  const totalValue = portfolioData.account.portfolio_value;
  
  let userRiskLevel, defaultPositionSizeDollars, maxPositionSize;
  
  if (constraints && Object.keys(constraints).length > 0) {
    console.log('💰 Using constraints from frontend:', constraints);
    userRiskLevel = apiSettings.user_risk_level || 'moderate';
    defaultPositionSizeDollars = constraints.minPositionSize || 1000;
    maxPositionSize = constraints.maxPositionSize ? (constraints.maxPositionSize / totalValue * 100) : 10;
  } else {
    const { data: userSettings } = await supabase
      .from('api_settings')
      .select('user_risk_level, default_position_size_dollars')
      .eq('user_id', userId)
      .single();
    
    userRiskLevel = userSettings?.user_risk_level || apiSettings.user_risk_level || 'moderate';
    defaultPositionSizeDollars = userSettings?.default_position_size_dollars || apiSettings.default_position_size_dollars || 1000;
    maxPositionSize = apiSettings.max_position_size || 10;
  }
  
  return {
    userRiskLevel,
    defaultPositionSizeDollars,
    maxPositionSize
  };
}

export function adjustConfidenceForRiskLevel(
  confidence: number,
  userRiskLevel: string
): number {
  const originalConfidence = confidence;
  
  if (userRiskLevel === 'conservative') {
    confidence = Math.round(confidence * 0.95);
  } else if (userRiskLevel === 'aggressive') {
    confidence = Math.round(confidence * 1.05);
  }
  
  console.log(`🎯 Risk level adjustment: ${userRiskLevel} - Original: ${originalConfidence}%, Adjusted: ${confidence}%`);
  return confidence;
}

export function validateDecision(
  decision: string,
  currentPosition: any,
  pendingOrdersForTicker: any[]
): { effectiveDecision: string; sellWarning: string; pendingOrderOverride: string } {
  let effectiveDecision = (decision === 'SELL' && !currentPosition) ? 'HOLD' : decision;
  let sellWarning = '';
  let pendingOrderOverride = '';
  
  const hasPendingBuy = pendingOrdersForTicker.some((o: any) => o.side === 'buy');
  const hasPendingSell = pendingOrdersForTicker.some((o: any) => o.side === 'sell');
  
  if (hasPendingBuy && decision === 'BUY') {
    effectiveDecision = 'HOLD';
    console.log(`⚠️ Overriding BUY decision - pending BUY order already exists`);
  }
  if (hasPendingSell && decision === 'SELL') {
    effectiveDecision = 'HOLD';
    console.log(`⚠️ Overriding SELL decision - pending SELL order already exists`);
  }
  
  sellWarning = (decision === 'SELL' && !currentPosition) 
    ? '\n\nNOTE: Risk Manager recommended SELL but no position exists. Treating as HOLD.'
    : '';
  
  pendingOrderOverride = effectiveDecision === 'HOLD' && effectiveDecision !== decision
    ? `\n\nCRITICAL: Decision overridden from ${decision} to HOLD due to existing pending ${hasPendingBuy ? 'BUY' : 'SELL'} order.`
    : '';
  
  return { effectiveDecision, sellWarning, pendingOrderOverride };
}

export function formatPendingOrdersInfo(
  ticker: string,
  pendingOrdersForTicker: any[],
  hasPendingBuy: boolean
): string {
  if (pendingOrdersForTicker.length === 0) return '';
  
  return `\n\n🚨 CRITICAL PENDING ORDER ALERT 🚨
  - ${ticker} has ${pendingOrdersForTicker.length} PENDING ORDER(S):
  ${pendingOrdersForTicker.map((o: any) => 
    `    ❌ ${o.side.toUpperCase()} ${o.qty || o.notional ? `${o.qty || 'notional'} shares` : 'unknown qty'}${o.notional ? ` ($${o.notional})` : ''}${o.limit_price ? ` @ $${o.limit_price}` : ''} (${new Date(o.submitted_at).toLocaleString()})`
  ).join('\n  ')}
  
  ⛔ MANDATORY RULE: DO NOT CREATE ANY NEW ORDERS FOR ${ticker}
  ⛔ RESPONSE MUST BE: "EXECUTION: HOLD - Pending ${hasPendingBuy ? 'BUY' : 'SELL'} order already exists, avoiding duplicates"`;
}

export function createTradeOrder(
  ticker: string,
  effectiveDecision: string,
  positionSizing: any,
  confidence: number,
  analysisId: string,
  currentPosition: any,
  currentPrice: number,
  totalValue: number
): TradeOrderData {
  const beforeShares = currentPosition?.qty || 0;
  const beforeValue = currentPosition?.market_value || 0;
  const beforeAllocation = (beforeValue / totalValue) * 100;
  
  let afterShares = beforeShares;
  let afterValue = beforeValue;
  
  if (effectiveDecision === 'BUY') {
    if (positionSizing.dollarAmount > 0) {
      const sharesFromDollar = positionSizing.dollarAmount / currentPrice;
      afterShares = beforeShares + sharesFromDollar;
      afterValue = beforeValue + positionSizing.dollarAmount;
    } else {
      afterShares = beforeShares + positionSizing.shares;
      afterValue = afterShares * currentPrice;
    }
  } else if (effectiveDecision === 'SELL') {
    if (positionSizing.dollarAmount > 0) {
      const sharesFromDollar = positionSizing.dollarAmount / currentPrice;
      afterShares = Math.max(0, beforeShares - sharesFromDollar);
      afterValue = afterShares * currentPrice;
    } else {
      afterShares = Math.max(0, beforeShares - positionSizing.shares);
      afterValue = afterShares * currentPrice;
    }
  }
  
  const afterAllocation = (afterValue / totalValue) * 100;
  
  return {
    ticker,
    action: effectiveDecision as 'BUY' | 'SELL',
    confidence,
    reasoning: `${positionSizing.reasoning}. Risk-adjusted position: ${positionSizing.percentOfPortfolio.toFixed(1)}% of portfolio.`,
    analysisId,
    beforeShares,
    beforeValue,
    beforeAllocation,
    afterShares,
    afterValue,
    afterAllocation,
    shareChange: afterShares - beforeShares,
    valueChange: afterValue - beforeValue,
    allocationChange: afterAllocation - beforeAllocation
  };
}