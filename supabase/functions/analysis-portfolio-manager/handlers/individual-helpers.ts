import { updateAnalysisPhase, updateAgentInsights, appendAnalysisMessage, updateWorkflowStepStatus } from '../../_shared/atomicUpdate.ts';
import { submitTradeOrders } from '../../_shared/tradeOrders.ts';
import { notifyCoordinatorAsync } from '../../_shared/coordinatorNotification.ts';
import { createTradeOrder } from './individual-logic.ts';
import { IndividualAnalysisResponse } from './individual-types.ts';
import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';

export async function executeTradeOrder(
  supabase: any,
  analysisId: string,
  ticker: string,
  effectiveDecision: string,
  originalDecision: string,
  positionSizing: any,
  confidence: number,
  currentPosition: any,
  currentPrice: number,
  totalValue: number,
  availableCash: number,
  userSettings: any,
  userId: string,
  apiSettings: any
): Promise<Response> {
  // Create trade order
  const tradeOrder = createTradeOrder(
    ticker, effectiveDecision, positionSizing, confidence,
    analysisId, currentPosition, currentPrice, totalValue
  );

  // Validate position sizing
  if (effectiveDecision === 'BUY' && (!positionSizing.dollarAmount || positionSizing.dollarAmount <= 0)) {
    console.warn(`⚠️ Invalid position sizing for ${ticker}`);
    
    await appendAnalysisMessage(
      supabase, analysisId, 'Analysis Portfolio Manager',
      `Unable to create BUY order: Invalid position size. Treating as HOLD.`,
      'warning'
    );
    
    return buildHoldResponse(
      supabase, analysisId, ticker, 'HOLD', originalDecision,
      availableCash, currentPosition, totalValue, userSettings.userRiskLevel,
      apiSettings
    );
  }
  
  // Always use dollar-based orders for simplicity and fractional share support
  tradeOrder.dollarAmount = positionSizing.dollarAmount;
  tradeOrder.shares = 0;
  console.log(`💰 Order type: Dollar-based ($${tradeOrder.dollarAmount?.toFixed(2)})`);

  // Submit trade order
  const result = await submitTradeOrders(supabase, tradeOrder, {
    userId,
    sourceType: 'individual_analysis',
    agent: 'analysis-portfolio-manager'
  });

  // Update agent insights
  await updatePortfolioManagerInsights(
    supabase, analysisId, effectiveDecision, originalDecision,
    positionSizing, tradeOrder, totalValue, availableCash,
    currentPosition, userSettings.userRiskLevel, result
  );

  console.log(`✅ Analysis Portfolio Manager completed: ${effectiveDecision} ${ticker}`);
  
  // Update workflow status
  await updateWorkflowStepStatus(supabase, analysisId, 'portfolio', 'Analysis Portfolio Manager', 'completed');
  
  // Mark analysis as complete
  await markAnalysisComplete(supabase, analysisId);

  // Notify coordinator
  notifyCoordinatorAsync(supabase, {
    analysisId, ticker, userId,
    phase: 'portfolio',
    agent: 'analysis-portfolio-manager',
    apiSettings,
    analysisContext: { type: 'individual' }
  }, 'Analysis Portfolio Manager');

  // Build response
  const response: IndividualAnalysisResponse = {
    success: true,
    analysis_id: analysisId,
    ticker,
    decision: effectiveDecision,
    originalDecision,
    portfolio_snapshot: {
      cash: availableCash,
      positions: currentPosition ? [{
        ticker,
        shares: currentPosition.qty,
        avgCost: currentPosition.avg_entry_price,
        currentPrice: currentPosition.current_price,
        value: currentPosition.market_value
      }] : [],
      totalValue,
      availableCash
    },
    positionSizing,
    tradeOrder: {
      ticker: tradeOrder.ticker,
      action: tradeOrder.action,
      confidence: tradeOrder.confidence,
      shares: tradeOrder.shares || 0,
      dollar_amount: tradeOrder.dollarAmount || 0,
      analysis_id: tradeOrder.analysisId || '',
      beforePosition: {
        shares: tradeOrder.beforeShares || 0,
        value: tradeOrder.beforeValue || 0,
        allocation: tradeOrder.beforeAllocation || 0
      },
      afterPosition: {
        shares: tradeOrder.afterShares || 0,
        value: tradeOrder.afterValue || 0,
        allocation: tradeOrder.afterAllocation || 0
      },
      changes: {
        shares: tradeOrder.shareChange || 0,
        value: tradeOrder.valueChange || 0,
        allocation: tradeOrder.allocationChange || 0
      },
      reasoning: tradeOrder.reasoning
    },
    orderSubmitted: result.success,
    ordersCreated: result.ordersCreated,
    auto_executed: false,
    created_at: new Date().toISOString()
  };
  
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function buildHoldResponse(
  supabase: any,
  analysisId: string,
  ticker: string,
  effectiveDecision: string,
  originalDecision: string,
  availableCash: number,
  currentPosition: any,
  totalValue: number,
  userRiskLevel: string,
  apiSettings: any
): Promise<Response> {
  // Update workflow status
  await updateWorkflowStepStatus(supabase, analysisId, 'portfolio', 'Analysis Portfolio Manager', 'completed');
  
  // Mark analysis as complete
  await markAnalysisComplete(supabase, analysisId);
  
  // Save HOLD message
  const holdMessage = originalDecision === 'SELL' && !currentPosition
    ? `Risk Manager recommended SELL but no position exists for ${ticker}. No action taken.`
    : `Decision: ${effectiveDecision} - No position adjustment needed.`;
    
  await appendAnalysisMessage(supabase, analysisId, 'Analysis Portfolio Manager', holdMessage, 'decision');
  
  // Update agent insights for HOLD
  const { data: currentInsights } = await supabase
    .from('analysis_history')
    .select('agent_insights')
    .eq('id', analysisId)
    .single();
  
  const existingPortfolioManagerInsight = currentInsights?.agent_insights?.portfolioManager || {};
  
  await updateAgentInsights(supabase, analysisId, 'portfolioManager', {
    ...existingPortfolioManagerInsight,
    finalDecision: {
      action: effectiveDecision,
      originalRiskManagerDecision: originalDecision,
      shares: 0,
      dollarAmount: 0,
      reasoning: originalDecision === 'SELL' && !currentPosition 
        ? 'Risk Manager recommended SELL but no position exists to sell'
        : 'No position adjustment needed based on current analysis and portfolio status'
    },
    portfolioContext: {
      totalValue,
      availableCash,
      currentPosition,
      userRiskLevel
    }
  });

  // Notify coordinator
  notifyCoordinatorAsync(supabase, {
    analysisId, ticker,
    userId: '', // Will be filled by coordinator
    phase: 'portfolio',
    agent: 'analysis-portfolio-manager',
    apiSettings,
    analysisContext: { type: 'individual' }
  }, 'Analysis Portfolio Manager');

  const response: IndividualAnalysisResponse = {
    success: true,
    analysis_id: analysisId,
    ticker,
    decision: effectiveDecision,
    originalDecision,
    message: originalDecision === 'SELL' && !currentPosition 
      ? 'SELL recommended but no position exists' 
      : 'No trade action required',
    portfolio_snapshot: {
      cash: availableCash,
      positions: currentPosition ? [{
        ticker,
        shares: currentPosition.qty,
        avgCost: currentPosition.avg_entry_price,
        currentPrice: currentPosition.current_price,
        value: currentPosition.market_value
      }] : [],
      totalValue,
      availableCash
    },
    created_at: new Date().toISOString()
  };
  
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function updatePortfolioManagerInsights(
  supabase: any,
  analysisId: string,
  effectiveDecision: string,
  originalDecision: string,
  positionSizing: any,
  tradeOrder: any,
  totalValue: number,
  availableCash: number,
  currentPosition: any,
  userRiskLevel: string,
  result: any
) {
  const { data: currentInsights } = await supabase
    .from('analysis_history')
    .select('agent_insights')
    .eq('id', analysisId)
    .single();
  
  const existingInsight = currentInsights?.agent_insights?.portfolioManager || {};
  
  await updateAgentInsights(supabase, analysisId, 'portfolioManager', {
    ...existingInsight,
    finalDecision: {
      action: effectiveDecision,
      originalRiskManagerDecision: originalDecision,
      shares: positionSizing.shares,
      dollarAmount: positionSizing.dollarAmount,
      percentOfPortfolio: positionSizing.percentOfPortfolio,
      entryPrice: positionSizing.entryPrice,
      stopLoss: positionSizing.stopLoss,
      takeProfit: positionSizing.takeProfit,
      riskRewardRatio: positionSizing.riskRewardRatio,
      reasoning: positionSizing.reasoning,
      beforePosition: {
        shares: tradeOrder.beforeShares,
        value: tradeOrder.beforeValue,
        allocation: tradeOrder.beforeAllocation
      },
      afterPosition: {
        shares: tradeOrder.afterShares,
        value: tradeOrder.afterValue,
        allocation: tradeOrder.afterAllocation
      },
      changes: {
        shares: tradeOrder.shareChange,
        value: tradeOrder.valueChange,
        allocation: tradeOrder.allocationChange
      }
    },
    portfolioContext: {
      totalValue,
      availableCash,
      currentPosition,
      userRiskLevel
    },
    orderSubmitted: result.success,
    ordersCreated: result.ordersCreated
  });
}

async function markAnalysisComplete(supabase: any, analysisId: string) {
  const { data: currentAnalysis } = await supabase
    .from('analysis_history')
    .select('full_analysis')
    .eq('id', analysisId)
    .single();
  
  const { error: statusError } = await supabase
    .from('analysis_history')
    .update({
      analysis_status: ANALYSIS_STATUS.COMPLETED,
      full_analysis: {
        ...currentAnalysis.full_analysis,
        status: 'completed',
        completedAt: new Date().toISOString()
      }
    })
    .eq('id', analysisId);
  
  if (statusError) {
    console.error('Failed to mark analysis as complete:', statusError);
  } else {
    console.log(`🎆 Analysis marked as completed`);
  }
}