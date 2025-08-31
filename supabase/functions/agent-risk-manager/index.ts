import { serve } from 'https://deno.land/std@0.210.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callAIProviderWithRetry, SYSTEM_PROMPTS } from '../_shared/aiProviders.ts'
import { checkAnalysisCancellation } from '../_shared/cancellationCheck.ts'
import { notifyCoordinatorAsync } from '../_shared/coordinatorNotification.ts'
import { AgentRequest } from '../_shared/types.ts'
import { updateAgentInsights, appendAnalysisMessage, updateWorkflowStepStatus, updateAnalysisPhase, updateFinalAnalysisResults, setAgentToError } from '../_shared/atomicUpdate.ts'
import { setupAgentTimeout, clearAgentTimeout, getRetryStatus } from '../_shared/agentSelfInvoke.ts'

serve(async (req) => {
  let timeoutId: number | null = null;
  let request: AgentRequest | null = null;

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Method not allowed'
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200 // Return 200 so coordinator notifications work
      });
    }

    request = await req.json();
    const { analysisId, ticker, userId, apiSettings, analysisContext } = request;

    if (!analysisId || !ticker || !userId || !apiSettings) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required parameters'
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200 // Return 200 so coordinator notifications work
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const retryStatus = getRetryStatus(request);
    console.log(`🎯 Risk Manager starting final assessment for ${ticker} (${retryStatus})`);
    console.log(`🤖 Using AI: ${apiSettings.ai_provider || 'openai'} | Model: ${apiSettings.ai_model || 'default'}`);

    // Setup timeout with self-retry mechanism
    timeoutId = setupAgentTimeout(
      supabase,
      request,
      {
        functionName: 'agent-risk-manager',
        maxRetries: 3,
        timeoutMs: 180000, // 3 minutes
        retryDelay: 3000   // 3 second delay between retries
      },
      'Risk Manager'
    );

    // Check if analysis has been canceled before starting work
    const cancellationCheck = await checkAnalysisCancellation(supabase, analysisId);
    if (!cancellationCheck.shouldContinue) {
      console.log(`🛑 agent-risk-manager stopped: ${cancellationCheck.reason}`);
      return new Response(JSON.stringify({
        success: false,
        message: `agent-risk-manager stopped: ${cancellationCheck.reason}`,
        canceled: cancellationCheck.isCanceled
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    }

    // Check if analysis still exists by trying to update it (deletion check)
    const updateResult = await updateAnalysisPhase(supabase, analysisId, 'Risk Manager analyzing', {
      agent: 'Risk Manager',
      message: 'Starting final risk assessment',
      timestamp: new Date().toISOString(),
      type: 'info'
    });

    // If analysis phase update fails, it likely means analysis was deleted
    if (!updateResult.success) {
      console.log(`🛑 Risk Manager stopped: ${updateResult.error}`);
      return new Response(JSON.stringify({
        success: false,
        message: `Risk Manager stopped: ${updateResult.error}`,
        canceled: true
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    }

    // Get complete analysis data
    const { data: analysis } = await supabase
      .from('analysis_history')
      .select('agent_insights, full_analysis')
      .eq('id', analysisId)
      .single();

    if (!analysis) {
      throw new Error('Analysis not found');
    }

    // Update analysis status
    await updateAnalysisPhase(supabase, analysisId, 'Risk Manager finalizing recommendations', {
      agent: 'Risk Manager',
      message: 'Synthesizing all risk perspectives for final recommendation',
      timestamp: new Date().toISOString(),
      type: 'info'
    });

    // Extract all risk analyst perspectives
    const riskyAnalyst = analysis.agent_insights?.riskyAnalyst?.strategies || {};
    const safeAnalyst = analysis.agent_insights?.safeAnalyst?.strategies || {};
    const neutralAnalyst = analysis.agent_insights?.neutralAnalyst?.strategies || {};
    const tradingPlan = analysis.full_analysis?.tradingPlan || {};
    const researchConclusion = analysis.full_analysis?.researchConclusion || {};

    // Prepare AI prompt
    const prompt = `
    As the Risk Manager for ${ticker}, synthesize all risk perspectives and provide final recommendations.
    
    Trading Plan Summary:
    - Recommendation: ${researchConclusion.recommendation}
    - Base Strategy: ${tradingPlan.action} with ${tradingPlan.positionSize} position
    - Entry: ${tradingPlan.entryPrice}, Stop: ${tradingPlan.stopLoss}

    Risk Analyst Perspectives:
    
    Aggressive (Risky Analyst):
    - Position Size: ${riskyAnalyst.aggressivePosition?.size}
    - Max Loss: ${riskyAnalyst.maxLoss}
    - Warning Level: ${riskyAnalyst.warningLevel}

    Conservative (Safe Analyst):
    - Position Size: ${safeAnalyst.conservativePosition?.size}
    - Max Loss: ${safeAnalyst.maxLoss}
    - Warning Level: ${safeAnalyst.warningLevel}

    Balanced (Neutral Analyst):
    - Position Size: ${neutralAnalyst.balancedPosition?.size}
    - Expected Return: ${neutralAnalyst.expectedReturn}
    - Warning Level: ${neutralAnalyst.warningLevel}

    Provide comprehensive risk management guidance including:
    1. Final position size recommendation for different investor types
    2. Comprehensive risk scoring (1-10 scale)
    3. Portfolio impact analysis
    4. Correlation and diversification considerations
    5. Black swan event preparation
    6. Specific risk monitoring checklist
    7. Clear exit criteria and conditions
    8. Final GO/NO-GO recommendation with confidence level
    `;

    // Call AI provider
    let aiResponse = '';
    let agentError = null;
    let errorType: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'database' | 'timeout' | 'other' = 'other';

    try {
      const maxTokens = apiSettings.risk_max_tokens || 1200;
      console.log(`📝 Using ${maxTokens} max tokens for final risk assessment`);
      aiResponse = await callAIProviderWithRetry(apiSettings, prompt, SYSTEM_PROMPTS.riskManager, maxTokens, 3);
    } catch (aiError) {
      console.error('❌ AI provider call failed:', aiError);
      agentError = aiError.message || 'Failed to get AI response';

      // Determine error type for proper categorization
      if (agentError.includes('rate limit') || agentError.includes('quota') || agentError.includes('insufficient_quota')) {
        errorType = 'rate_limit';
      } else if (agentError.includes('API key') || agentError.includes('api_key') || agentError.includes('invalid key') || agentError.includes('Incorrect API key')) {
        errorType = 'api_key';
      } else if (agentError.includes('timeout') || agentError.includes('timed out')) {
        errorType = 'timeout';
      } else {
        errorType = 'ai_error';
      }

      // Set a fallback response when AI fails
      aiResponse = `Error: Unable to complete final risk assessment due to AI provider error.

Risk analysis data was collected but final assessment could not be made.

Error details: ${agentError}

Please retry the analysis or check your AI provider settings.`;
    }

    // Calculate comprehensive risk score
    const riskScore = calculateRiskScore(analysis.agent_insights);

    // Determine final recommendation based on investor profile
    const finalRecommendations = {
      aggressive: {
        action: tradingPlan.action,
        positionSize: '7-10%',
        strategy: 'Full position with options overlay',
        maxLoss: '10-15%'
      },
      moderate: {
        action: tradingPlan.action,
        positionSize: '3-5%',
        strategy: 'Scaled entry with stops',
        maxLoss: '5-7%'
      },
      conservative: {
        action: tradingPlan.action === 'BUY' ? 'CAUTIOUS BUY' : tradingPlan.action,
        positionSize: '1-2%',
        strategy: 'Small position with hedges',
        maxLoss: '2-3%'
      }
    };

    // Save agent output
    const agentOutput = {
      agent: 'Risk Manager',
      timestamp: new Date().toISOString(),
      analysis: aiResponse,
      finalAssessment: {
        overallRiskScore: riskScore,
        marketRisk: 'Medium',
        executionRisk: 'Low',
        liquidityRisk: 'Low',
        recommendations: finalRecommendations,
        decision: '', // Will be filled from AI extraction
        confidence: '70%', // Will be updated with extracted value from AI
        keyRisks: [
          'Market volatility',
          'Valuation concerns',
          'Sector rotation risk'
        ],
        monitoringPlan: {
          daily: ['Price action', 'Volume', 'News flow'],
          weekly: ['Technical indicators', 'Sector performance'],
          monthly: ['Fundamental changes', 'Portfolio weight']
        }
      }
    };

    // Extract final decision and confidence from AI analysis
    const finalDecision = extractDecisionFromAI(aiResponse, researchConclusion, riskScore);

    // Update the confidence and decision in agentOutput to use the extracted values
    agentOutput.finalAssessment.confidence = `${finalDecision.confidence}%`;
    agentOutput.finalAssessment.decision = finalDecision.decision;

    // Update agent insights atomically
    const insightsResult = await updateAgentInsights(supabase, analysisId, 'riskManager', agentOutput);
    if (!insightsResult.success) {
      console.error('Failed to update insights:', insightsResult.error);
    }

    // Append message atomically
    const messageResult = await appendAnalysisMessage(
      supabase,
      analysisId,
      'Risk Manager',
      aiResponse,
      'final-assessment'
    );
    if (!messageResult.success) {
      console.error('Failed to append message:', messageResult.error);
    }

    // Update decision and confidence but NOT final status (Portfolio Manager will do that)
    const { error: updateError } = await supabase
      .from('analysis_history')
      .update({
        decision: finalDecision.decision,
        confidence: finalDecision.confidence,
        // Don't set analysis_status to completed here - Portfolio Manager will do that
      })
      .eq('id', analysisId);

    if (updateError) {
      console.error('Failed to update decision:', updateError);
    }

    // Update watchlist with last analysis date and decision
    console.log(`📊 Updating watchlist for ${ticker} with decision: ${finalDecision.decision}`);
    const { error: watchlistError } = await supabase
      .from('watchlist')
      .update({
        last_analysis: new Date().toISOString(),
        last_decision: finalDecision.decision
      })
      .eq('user_id', userId)
      .eq('ticker', ticker);

    if (watchlistError) {
      console.error('⚠️ Failed to update watchlist:', watchlistError);
    } else {
      console.log('✅ Watchlist updated successfully');
    }

    // Handle agent completion - either success or error
    if (agentError) {
      // Set agent to error status
      const errorResult = await setAgentToError(
        supabase,
        analysisId,
        'risk',
        'Risk Manager',
        agentError,
        errorType,
        ticker,
        userId,
        apiSettings
      );

      if (!errorResult.success) {
        console.error('Failed to set error status:', errorResult.error);
      }

      // Clear timeout on error
      if (timeoutId !== null) {
        clearAgentTimeout(timeoutId, 'Risk Manager', 'error in AI processing');
      }

      // Don't continue to next phase on error
      console.log('❌ Risk Manager encountered error - not notifying coordinator');

      return new Response(JSON.stringify({
        success: false,
        agent: 'Risk Manager',
        error: agentError,
        errorType: errorType,
        finalAssessment: agentOutput.finalAssessment,
        retryInfo: retryStatus
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    } else {
      // Only set to completed if no errors
      await updateWorkflowStepStatus(supabase, analysisId, 'risk', 'Risk Manager', 'completed');

      // Clear timeout on successful completion
      if (timeoutId !== null) {
        clearAgentTimeout(timeoutId, 'Risk Manager', 'completed successfully');
      }

      console.log(`✅ Risk Manager completed final assessment for ${ticker} (${retryStatus})`);
      console.log(`📊 Final Decision: ${finalDecision.decision} with ${finalDecision.confidence}% confidence`);
      console.log(`📤 Passing to Portfolio Manager for position sizing...`);

      // Notify coordinator of completion using reliable notification with retry logic
      notifyCoordinatorAsync(supabase, {
        analysisId,
        ticker,
        userId,
        phase: 'risk',
        agent: 'risk-manager',
        apiSettings
      }, 'Risk Manager');
    }

    return new Response(JSON.stringify({
      success: true,
      agent: 'Risk Manager',
      finalAssessment: agentOutput.finalAssessment,
      decision: finalDecision,
      retryInfo: retryStatus
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    // Clear timeout on error
    if (timeoutId !== null) {
      clearAgentTimeout(timeoutId, 'Risk Manager', 'error occurred');
    }

    console.error('❌ Risk Manager critical error:', error);

    // Try to set error status for uncaught exceptions
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      if (analysisId) {
        // Determine error type
        let errorType: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'database' | 'timeout' | 'other' = 'other';
        const errorMessage = error.message || 'Unknown error';

        if (errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
          errorType = 'rate_limit';
        } else if (errorMessage.includes('API key') || errorMessage.includes('api_key') || errorMessage.includes('invalid key')) {
          errorType = 'api_key';
        } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
          errorType = 'timeout';
        } else if (errorMessage.includes('database') || errorMessage.includes('supabase')) {
          errorType = 'database';
        } else if (errorMessage.includes('fetch') || errorMessage.includes('network')) {
          errorType = 'data_fetch';
        }

        await setAgentToError(
          supabase,
          analysisId,
          'risk',
          'Risk Manager',
          errorMessage,
          errorType,
          request.ticker,
          request.userId,
          request.apiSettings
        );
      }
    } catch (errorUpdateError) {
      console.error('Failed to update error status:', errorUpdateError);
    }

    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200 // Return 200 so coordinator notifications work
    });
  }
});

function calculateRiskScore(agentInsights: any): number {
  let totalScore = 0;
  let factors = 0;

  // Market risk factors
  const volatility = agentInsights.marketAnalyst?.data?.volatility?.current || 'medium';
  if (volatility === 'low') totalScore += 2;
  else if (volatility === 'medium') totalScore += 5;
  else totalScore += 8;
  factors++;

  // Fundamental risk
  const fundamentalScore = agentInsights.fundamentalsAnalyst?.summary?.fundamentalScore || 50;
  totalScore += Math.round((100 - fundamentalScore) / 10);
  factors++;

  // Sentiment risk
  const sentiment = agentInsights.socialMediaAnalyst?.summary?.overallSentiment || 'neutral';
  if (sentiment === 'positive') totalScore += 3;
  else if (sentiment === 'neutral') totalScore += 5;
  else totalScore += 7;
  factors++;

  // Research conclusion risk
  const conviction = agentInsights.researchManager?.summary?.conviction || 5;
  totalScore += (10 - conviction);
  factors++;

  return Math.round(totalScore / factors);
}

function extractDecisionFromAI(aiResponse: string, researchConclusion: any, riskScore: number) {
  let decision = 'HOLD';
  let confidence = 70;

  try {
    // Extract decision using TradingGoose-style patterns
    const decisionMatches = [
      /FINAL TRANSACTION PROPOSAL:\s*\*\*(BUY|SELL|HOLD)\*\*/i,
      /FINAL DECISION:\s*(BUY|SELL|HOLD|NO-GO|GO)/i,
      /Decision:\s*(BUY|SELL|HOLD|NO-GO|GO)/i,
      /Recommendation:\s*(BUY|SELL|HOLD|NO-GO|GO)/i,
      /(BUY|SELL|HOLD|NO-GO|GO)\s*for new positions/i,
      /clear and actionable recommendation:\s*(BUY|SELL|HOLD)/i
    ];

    for (const regex of decisionMatches) {
      const match = aiResponse.match(regex);
      if (match) {
        const extractedDecision = match[1].toUpperCase();
        // Map AI decisions to standard format
        if (extractedDecision === 'NO-GO') {
          decision = 'SELL';
        } else if (extractedDecision === 'GO') {
          decision = 'BUY';
        } else {
          decision = extractedDecision;
        }
        break;
      }
    }

    // Try to extract confidence from the AI response first
    const confidencePatterns = [
      /Confidence\s*Level[:\s]+(\d+)\/10/i,
      /Confidence[:\s]+(\d+)\/10/i,
      /(\d+)\/10\s+(?:\()?(?:High|Medium|Low)?\s*confidence/i,
      /confidence[:\s]+(\d+)%/i,
      /confidence[:\s]*(\d+)\s*%/i,  // More flexible with spaces
      /(\d+)%\s+confidence/i,
      /(\d+)\s*%\s+confidence/i,     // Handle spaces before %
      /Confidence:\s*(\d+)\s*%/i,    // Capital C with flexible spacing
      /with\s+(\d+)%\s+confidence/i, // "with X% confidence"
      /(\d+)%\s+confident/i          // "X% confident"
    ];

    let extractedConfidence = false;
    for (const pattern of confidencePatterns) {
      const match = aiResponse.match(pattern);
      if (match) {
        const value = parseInt(match[1]);
        if (value <= 10) {
          // Convert from /10 scale to percentage
          confidence = value * 10;
        } else {
          // Already in percentage
          confidence = Math.min(100, value);
        }
        extractedConfidence = true;
        console.log(`📊 Extracted confidence from AI: ${confidence}%`);
        break;
      }
    }

    // Only calculate confidence if not extracted from AI
    if (!extractedConfidence) {
      confidence = calculateConfidenceFromRiskScore(riskScore, decision, aiResponse);
      console.log(`📊 Calculated confidence from risk score: ${confidence}%`);
    }

    console.log(`🎯 Extracted from AI: Decision="${decision}", Confidence=${confidence}%`);

  } catch (error) {
    console.error('Error extracting decision from AI response:', error);
    // Fallback to research conclusion (no automatic HOLD default!)
    if (researchConclusion?.recommendation) {
      decision = researchConclusion.recommendation.toUpperCase();
      console.log(`📊 Using Research Manager recommendation: ${decision}`);
    } else {
      // If no clear decision, analyze the risk score to make one
      if (riskScore <= 4) {
        decision = 'BUY';
        console.log(`📊 Low risk score (${riskScore}) suggests BUY`);
      } else if (riskScore >= 7) {
        decision = 'SELL';
        console.log(`📊 High risk score (${riskScore}) suggests SELL`);
      } else {
        decision = 'HOLD';
        console.log(`📊 Moderate risk score (${riskScore}) suggests HOLD`);
      }
    }
    confidence = 70;
  }

  return { decision, confidence };
}

function calculateConfidenceFromRiskScore(riskScore: number, decision: string, aiResponse: string): number {
  let baseConfidence = 70;

  // Adjust confidence based on risk score (lower risk = higher confidence)
  if (riskScore <= 3) {
    baseConfidence = 90;
  } else if (riskScore <= 5) {
    baseConfidence = 80;
  } else if (riskScore <= 7) {
    baseConfidence = 70;
  } else {
    baseConfidence = 60;
  }

  // Adjust based on decision type
  if (decision === 'HOLD') {
    baseConfidence -= 10; // HOLD typically indicates uncertainty
  }

  // Look for confidence indicators in the text
  const strongIndicators = [
    /strongly/i, /clear/i, /definitive/i, /compelling/i, /robust/i, /significant/i
  ];
  const weakIndicators = [
    /cautious/i, /uncertain/i, /mixed/i, /limited/i, /moderate/i, /potential/i
  ];

  let strengthAdjustment = 0;
  strongIndicators.forEach(regex => {
    if (regex.test(aiResponse)) strengthAdjustment += 5;
  });
  weakIndicators.forEach(regex => {
    if (regex.test(aiResponse)) strengthAdjustment -= 5;
  });

  return Math.max(50, Math.min(95, baseConfidence + strengthAdjustment));
}



