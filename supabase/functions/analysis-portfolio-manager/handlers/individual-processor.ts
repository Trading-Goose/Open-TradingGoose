import { updateAnalysisPhase, updateAgentInsights, appendAnalysisMessage, setAgentToError } from '../../_shared/atomicUpdate.ts';
import { callAIProviderWithRetry } from '../../_shared/aiProviders.ts';
import { extractPositionSizing } from '../parsers/position-parser.ts';
import { generateIndividualAnalysisPrompt, generateIndividualSystemPrompt, generateIndividualReasoningPrompt, generateReasoningSystemPrompt } from '../ai/prompts.ts';
import { 
  prepareUserSettings, 
  adjustConfidenceForRiskLevel, 
  validateDecision, 
  formatPendingOrdersInfo
} from './individual-logic.ts';

export async function processAnalysisData(
  supabase: any,
  analysis: any,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: any,
  portfolioData: any,
  constraints?: any
): Promise<{ success: boolean; data?: any; error?: string; status?: number }> {
  
  await updateAnalysisPhase(supabase, analysisId, 'portfolio', {
    agent: 'Analysis Portfolio Manager',
    message: 'Analyzing portfolio and calculating optimal position',
    timestamp: new Date().toISOString(),
    type: 'info'
  });

  // Extract key data
  const decision = analysis.decision;
  let confidence = analysis.confidence;
  const riskAssessment = analysis.agent_insights?.riskManager?.finalAssessment;
  
  // Portfolio metrics
  const totalValue = portfolioData.account.portfolio_value;
  const availableCash = portfolioData.account.cash;
  const currentPosition = portfolioData.positions.find((p: any) => p.symbol === ticker);
  
  // Prepare user settings
  const userSettings = await prepareUserSettings({
    supabase, userId, apiSettings, constraints, portfolioData
  });
  
  // Adjust confidence for risk level
  const originalConfidence = confidence;
  confidence = adjustConfidenceForRiskLevel(confidence, userSettings.userRiskLevel);
  
  // Get current price
  const currentPrice = riskAssessment?.currentPrice || 
                      analysis.agent_insights?.marketAnalyst?.data?.price?.current || 
                      analysis.agent_insights?.marketAnalyst?.data?.currentPrice || 0;
  
  // Validate price
  if (currentPrice <= 0 && decision !== 'HOLD') {
    console.error(`❌ No valid current price for ${ticker}`);
    
    await appendAnalysisMessage(
      supabase, analysisId, 'Analysis Portfolio Manager',
      `Unable to calculate position size for ${ticker}: No valid current price available.`,
      'error'
    );
    
    return {
      success: false,
      error: 'No valid current price available',
      status: 400
    };
  }

  // Check pending orders
  const pendingOrdersForTicker = portfolioData.openOrders?.filter((o: any) => o.symbol === ticker) || [];
  const hasPendingBuy = pendingOrdersForTicker.some((o: any) => o.side === 'buy');
  
  // Validate decision
  const { effectiveDecision, sellWarning, pendingOrderOverride } = validateDecision(
    decision, currentPosition, pendingOrdersForTicker
  );
  
  // Format pending orders info
  const pendingOrdersInfo = formatPendingOrdersInfo(ticker, pendingOrdersForTicker, hasPendingBuy);
  
  // Generate AI analysis
  const aiAnalysisResult = await generateAIAnalysis(
    ticker, totalValue, availableCash, currentPosition, userSettings,
    decision, effectiveDecision, confidence, originalConfidence, riskAssessment,
    currentPrice, pendingOrdersInfo, pendingOrdersForTicker, sellWarning,
    pendingOrderOverride, hasPendingBuy, apiSettings
  );
  
  if (!aiAnalysisResult.success) {
    return aiAnalysisResult;
  }
  
  // Handle AI errors
  if (aiAnalysisResult.agentError) {
    console.error('❌ Portfolio Manager AI error:', aiAnalysisResult.agentError);
    
    // Determine error type
    let errorType: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'database' | 'timeout' | 'other' = 'ai_error';
    const errorMessage = aiAnalysisResult.agentError;
    
    if (errorMessage.includes('rate limit') || errorMessage.includes('quota') || errorMessage.includes('insufficient_quota')) {
      errorType = 'rate_limit';
    } else if (errorMessage.includes('API key') || errorMessage.includes('api_key') || errorMessage.includes('invalid key') || errorMessage.includes('Incorrect API key')) {
      errorType = 'api_key';
    } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      errorType = 'timeout';
    }
    
    // Set agent to error status
    await setAgentToError(
      supabase,
      analysisId,
      'portfolio',
      'Analysis Portfolio Manager',
      errorMessage,
      errorType
    );
    
    return {
      success: false,
      error: errorMessage,
      errorType: errorType,
      status: 400
    };
  }
  
  // Save AI response (only if successful)
  await appendAnalysisMessage(supabase, analysisId, 'Analysis Portfolio Manager', aiAnalysisResult.combinedResponse!, 'analysis');
  await updateAgentInsights(supabase, analysisId, 'portfolioManager', {
    analysis: aiAnalysisResult.combinedResponse,
    timestamp: new Date().toISOString()
  });

  // Extract position sizing
  const positionSizing = await extractPositionSizing(aiAnalysisResult.aiResponse!, {
    totalValue,
    availableCash,
    currentPrice,
    defaultPositionSizeDollars: userSettings.defaultPositionSizeDollars,
    maxPositionSize: userSettings.maxPositionSize,
    userRiskLevel: userSettings.userRiskLevel,
    confidence,
    decision: effectiveDecision,
    ticker,
    apiSettings: aiAnalysisResult.pmApiSettings
  }, aiAnalysisResult.pmApiSettings);

  return {
    success: true,
    data: {
      effectiveDecision,
      originalDecision: decision,
      confidence,
      positionSizing,
      currentPosition,
      currentPrice,
      totalValue,
      availableCash,
      userSettings,
      pendingOrdersForTicker
    }
  };
}

async function generateAIAnalysis(
  ticker: string, totalValue: number, availableCash: number, currentPosition: any,
  userSettings: any, decision: string, effectiveDecision: string, confidence: number,
  originalConfidence: number, riskAssessment: any, currentPrice: number,
  pendingOrdersInfo: string, pendingOrdersForTicker: any[], sellWarning: string,
  pendingOrderOverride: string, hasPendingBuy: boolean, apiSettings: any
): Promise<{ success: boolean; aiResponse?: string; combinedResponse?: string; agentError?: string; pmApiSettings?: any }> {
  
  // Prepare AI prompt
  const prompt = generateIndividualAnalysisPrompt(
    ticker, totalValue, availableCash, currentPosition, userSettings.userRiskLevel,
    decision, effectiveDecision, confidence, originalConfidence, riskAssessment,
    currentPrice, userSettings.maxPositionSize, pendingOrdersInfo, pendingOrdersForTicker,
    sellWarning, pendingOrderOverride, hasPendingBuy, userSettings.defaultPositionSizeDollars
  );

  const systemPrompt = generateIndividualSystemPrompt();
  
  // The apiSettings already have the correct provider and API key from getAgentSpecificSettings
  // No need to reconfigure - just use them directly
  const pmApiSettings = apiSettings;
  
  // Call AI for decision
  let aiResponse = '';
  let agentError = null;
  
  try {
    const baseTokens = apiSettings.portfolio_manager_max_tokens || 1200;
    const decisionTokens = Math.floor(baseTokens / 2);
    console.log(`📝 Using ${decisionTokens} max tokens for portfolio analysis (1/2 of ${baseTokens})`);
    aiResponse = await callAIProviderWithRetry(pmApiSettings, prompt, systemPrompt, decisionTokens, 3);
  } catch (aiError) {
    console.error('❌ AI provider call failed:', aiError);
    agentError = aiError.message || 'Failed to get AI response';
    aiResponse = `Error: Unable to complete portfolio analysis. ${agentError}`;
  }

  // Generate detailed reasoning in parallel (if no error)
  let detailedReasoning = '';
  if (!agentError) {
    try {
      const reasoningPrompt = generateIndividualReasoningPrompt(
        aiResponse, ticker, totalValue, availableCash, currentPosition,
        userSettings.userRiskLevel, decision, confidence, riskAssessment, currentPrice, userSettings.maxPositionSize
      );
      const reasoningSystemPrompt = generateReasoningSystemPrompt();
      const reasoningMaxTokens = apiSettings.portfolio_manager_max_tokens || 1200;
      
      console.log(`📝 Generating detailed reasoning with ${reasoningMaxTokens} max tokens`);
      detailedReasoning = await callAIProviderWithRetry(pmApiSettings, reasoningPrompt, reasoningSystemPrompt, reasoningMaxTokens, 3);
    } catch (reasoningError) {
      console.error('❌ Failed to generate detailed reasoning:', reasoningError);
      detailedReasoning = `Unable to generate detailed reasoning: ${reasoningError.message}`;
    }
  }

  // Combine decision and reasoning
  const combinedResponse = detailedReasoning 
    ? `${aiResponse}

---

## Detailed Portfolio Reasoning

${detailedReasoning}`
    : aiResponse;

  return {
    success: true,
    aiResponse,
    combinedResponse,
    agentError,
    pmApiSettings
  };
}

export async function executeAnalysisDecision(
  supabase: any,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: any,
  analysisData: any,
  portfolioData: any
): Promise<Response> {
  const {
    effectiveDecision,
    originalDecision,
    confidence,
    positionSizing,
    currentPosition,
    currentPrice,
    totalValue,
    availableCash,
    userSettings,
    pendingOrdersForTicker
  } = analysisData;

  // Safety check for pending orders
  if (pendingOrdersForTicker.length > 0) {
    console.log(`🚨 SAFETY CHECK: ${ticker} has pending orders - blocking order creation`);
    await appendAnalysisMessage(
      supabase, analysisId, 'Analysis Portfolio Manager',
      `SAFETY OVERRIDE: Blocked order creation for ${ticker} due to existing pending orders.`,
      'warning'
    );
    
    // Build HOLD response
    const { buildHoldResponse } = await import('./individual-helpers.ts');
    return buildHoldResponse(
      supabase, analysisId, ticker, effectiveDecision, originalDecision,
      availableCash, currentPosition, totalValue, userSettings.userRiskLevel,
      apiSettings
    );
  }
  
  // Execute trade if needed
  const shouldExecuteTrade = 
    (effectiveDecision === 'BUY' && positionSizing.dollarAmount > 0) ||
    (effectiveDecision === 'SELL' && (positionSizing.dollarAmount > 0 || currentPosition));
  
  if (shouldExecuteTrade) {
    const { executeTradeOrder } = await import('./individual-helpers.ts');
    return executeTradeOrder(
      supabase, analysisId, ticker, effectiveDecision, originalDecision,
      positionSizing, confidence, currentPosition, currentPrice,
      totalValue, availableCash, userSettings, userId, apiSettings
    );
  }

  // Return HOLD response
  const { buildHoldResponse } = await import('./individual-helpers.ts');
  return buildHoldResponse(
    supabase, analysisId, ticker, effectiveDecision, originalDecision,
    availableCash, currentPosition, totalValue, userSettings.userRiskLevel,
    apiSettings
  );
}