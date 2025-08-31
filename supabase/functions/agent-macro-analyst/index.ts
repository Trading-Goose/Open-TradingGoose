import { serve } from 'https://deno.land/std@0.210.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { appendAnalysisMessage, updateAgentInsights, updateWorkflowStepStatus, updateAnalysisPhase, setAgentToError } from '../_shared/atomicUpdate.ts'
import { checkAnalysisCancellation } from '../_shared/cancellationCheck.ts'
import { notifyCoordinatorAsync } from '../_shared/coordinatorNotification.ts'
import { invokeNextAgentInSequence } from '../_shared/phaseProgressChecker.ts'
import { setupAgentTimeout, clearAgentTimeout, getRetryStatus } from '../_shared/agentSelfInvoke.ts'
import { AgentRequest } from '../_shared/types.ts'
import { callPerplefina } from '../_shared/perplefinaClient.ts'
import {
  createMethodNotAllowedResponse,
  createMissingParametersResponse,
  createCanceledResponse,
  createSuccessResponse,
  createErrorResponse,
  createApiErrorResponse
} from '../_shared/responseHelpers.ts'

serve(async (req) => {
  let timeoutId: number | null = null;

  try {
    if (req.method !== 'POST') {
      return createMethodNotAllowedResponse();
    }

    const request: AgentRequest = await req.json();
    const { analysisId, ticker, userId, apiSettings } = request;

    if (!analysisId || !ticker || !userId || !apiSettings) {
      const missingParams = [];
      if (!analysisId) missingParams.push('analysisId');
      if (!ticker) missingParams.push('ticker');
      if (!userId) missingParams.push('userId');
      if (!apiSettings) missingParams.push('apiSettings');
      return createMissingParametersResponse(missingParams);
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const retryStatus = getRetryStatus(request);
    console.log(`🌍 Macro Analyst starting for ${ticker} (${retryStatus})`);
    console.log(`🤖 Using AI: ${apiSettings.ai_provider || 'openai'} | Model: ${apiSettings.ai_model || 'default'}`);

    // Debug token values
    console.log(`🔍 DEBUG: apiSettings.analysis_max_tokens = ${apiSettings.analysis_max_tokens}`);
    console.log(`🔍 DEBUG: typeof apiSettings.analysis_max_tokens = ${typeof apiSettings.analysis_max_tokens}`);
    if (apiSettings.analysis_max_tokens > 10000) {
      console.warn(`⚠️ WARNING: Extremely high analysis_max_tokens detected: ${apiSettings.analysis_max_tokens}`);
      console.log(`🔍 DEBUG: Full apiSettings:`, JSON.stringify(apiSettings, null, 2));
    }

    // Setup timeout with self-retry mechanism
    timeoutId = setupAgentTimeout(
      supabase,
      request,
      {
        functionName: 'agent-macro-analyst',
        maxRetries: 3,
        timeoutMs: 180000,
        retryDelay: 3000   // 3 second delay between retries
      },
      'Macro Analyst'
    );

    // Check if analysis has been canceled before starting work
    const cancellationCheck = await checkAnalysisCancellation(supabase, analysisId);
    if (!cancellationCheck.shouldContinue) {
      console.log(`🛑 Macro Analyst stopped: ${cancellationCheck.reason}`);
      return createCanceledResponse(
        `Macro Analyst stopped: ${cancellationCheck.reason}`,
        cancellationCheck.isCanceled
      );
    }

    // Update analysis status
    const updateResult = await updateAnalysisPhase(supabase, analysisId, 'Macro Analyst analyzing economic indicators', {
      agent: 'Macro Analyst',
      message: 'Analyzing macroeconomic conditions and their impact using Perplefina',
      timestamp: new Date().toISOString(),
      type: 'info'
    });

    // If analysis phase update fails, it likely means analysis was deleted
    if (!updateResult.success) {
      console.log(`🛑 Macro Analyst stopped: ${updateResult.error}`);
      return createCanceledResponse(
        `Macro Analyst stopped: ${updateResult.error}`,
        true
      );
    }

    // Map optimization mode to source count
    const optimizationMode = apiSettings.analysis_optimization || 'normal';
    const maxSources = optimizationMode === 'balanced' ? 15 : 10;

    console.log(`📊 Using optimization: ${optimizationMode} with ${maxSources} sources`);

    // Call Perplefina API for macroeconomic analysis
    let aiResponse = '';
    let agentError = null;
    let perplefinaData = null;

    try {
      // Get current date for more precise news queries
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const data = await callPerplefina({
        focusMode: 'macroEconomy',
        query: `What's the trading recommendation for ${ticker} at current global macro economic situation based on analysis of Fed policy, inflation data, growth outlook, interest rates, short term stock investment recommendations, and key risks as of the day ${currentDate}`,
        optimizationMode: optimizationMode,
        maxSources: maxSources,
        chatModel: {
          provider: apiSettings.ai_provider,
          model: apiSettings.ai_model || 'default',
          apiKey: apiSettings.ai_api_key
        },
        maxTokens: apiSettings.analysis_max_tokens || 1200,
        systemInstructions: `You are a macroeconomic analyst tasked with analyzing how current economic conditions impact ${ticker}. Provide detailed analysis of macroeconomic factors including interest rates, inflation trends, GDP growth, employment data, monetary policy, fiscal policy, and global economic conditions. Explain how these factors specifically affect ${ticker} and its sector. Based on your macroeconomic analysis, provide a clear BUY/SELL/HOLD recommendation with supporting rationale. Make sure to append a Markdown table at the end organizing key points: Economic Outlook, Key Positive Factors, Key Risk Factors, Sector Impact, Macro-Based Recommendation (BUY/SELL/HOLD), Confidence Level.`
      });

      aiResponse = data.message || 'No analysis content received from Perplefina';
      perplefinaData = data.sources || [];

      // Log the full raw response for debugging
      console.log('📦 Raw Perplefina Response for Macro Analyst:');
      console.log(JSON.stringify(data, null, 2));
      console.log(`📊 Response summary: ${perplefinaData.length} sources, ${aiResponse.length} chars message`);

    } catch (aiError) {
      console.error('❌ Perplefina call failed:', aiError);
      agentError = aiError.message || 'Failed to get Perplefina response';
      aiResponse = `Error: Unable to complete macroeconomic analysis due to Perplefina error.

Error details: ${agentError}

Please retry the analysis or check your Perplefina configuration.`;
    }

    // Save agent output (even if there was an error)
    const agentOutput = {
      agent: 'Macro Analyst',
      timestamp: new Date().toISOString(),
      sources: perplefinaData,
      analysis: aiResponse,
      error: agentError
    };

    // Update analysis atomically to prevent race conditions
    console.log('💾 Updating analysis results atomically...');

    // Handle agent completion - either success or error
    if (agentError) {
      // Set agent to error status using the new helper function
      const errorResult = await setAgentToError(
        supabase,
        analysisId,
        'analysis',
        'Macro Analyst',
        agentError,
        agentError.includes('rate limit') || agentError.includes('quota') ? 'rate_limit' :
          agentError.includes('API key') || agentError.includes('invalid key') || agentError.includes('api_key') ? 'api_key' :
            agentError.includes('Perplefina') || agentError.includes('perplefina') ? 'data_fetch' :
              agentError.includes('AI provider') || agentError.includes('No API key provided') ? 'ai_error' : 'other',
        ticker,
        userId,
        apiSettings
      );
      if (!errorResult.success) {
        console.error('Failed to set agent to error:', errorResult.error);
      }
      console.log('⚠️ Macro Analyst completed with errors - analysis will continue');
    } else {
      // Update agent insights for successful completion
      const insightsResult = await updateAgentInsights(supabase, analysisId, 'macroAnalyst', agentOutput);
      if (!insightsResult.success) {
        console.error('Failed to update insights:', insightsResult.error);
      }

      // Append message atomically
      const messageResult = await appendAnalysisMessage(
        supabase,
        analysisId,
        'Macro Analyst',
        aiResponse,
        'analysis'
      );
      if (!messageResult.success) {
        console.error('Failed to append message:', messageResult.error);
      }

      // Update workflow step status to completed
      const statusResult = await updateWorkflowStepStatus(
        supabase,
        analysisId,
        'analysis',
        'Macro Analyst',
        'completed'
      );
      if (!statusResult.success) {
        console.error('Failed to update workflow status:', statusResult.error);
      }
      console.log('✅ Macro Analyst data saved successfully');
    }

    // Clear timeout on successful completion
    if (timeoutId !== null) {
      clearAgentTimeout(timeoutId, 'Macro Analyst', 'completed successfully');
    }

    // Only invoke next agent if this agent completed successfully
    if (agentError) {
      // Notify coordinator about the error - do NOT invoke next agent
      console.log(`⚠️ Macro Analyst completed with errors - notifying coordinator, NOT invoking next agent`);
      notifyCoordinatorAsync(supabase, {
        analysisId,
        ticker,
        userId,
        phase: 'analysis',
        agent: 'macro-analyst',
        apiSettings,
        error: agentError,
        errorType: agentError.includes('rate limit') || agentError.includes('quota') ? 'rate_limit' :
          agentError.includes('API key') || agentError.includes('invalid key') || agentError.includes('api_key') ? 'api_key' :
            agentError.includes('Perplefina') || agentError.includes('perplefina') ? 'data_fetch' :
              agentError.includes('AI provider') || agentError.includes('No API key provided') ? 'ai_error' : 'other',
        completionType: 'error',
        analysisContext: request.analysisContext
      }, 'Macro Analyst');
    } else {
      // Success case - invoke next agent
      console.log(`🔄 Macro Analyst attempting to invoke next agent in analysis phase...`);

      const nextAgentResult = await invokeNextAgentInSequence(
        supabase,
        analysisId,
        'analysis',
        'macro-analyst',  // Current agent name (not the next one)
        ticker,
        request.userId,
        request.apiSettings,
        request.analysisContext
      );

      if (nextAgentResult.success) {
        if (nextAgentResult.isLastInPhase) {
          // We're the last agent in analysis phase - notify coordinator for phase transition
          console.log(`📋 Macro Analyst is last in analysis phase - notifying coordinator for phase transition`);
          notifyCoordinatorAsync(supabase, {
            analysisId,
            ticker,
            userId,
            phase: 'analysis',
            agent: 'macro-analyst',
            apiSettings,
            completionType: 'last_in_phase',
            analysisContext: request.analysisContext
          }, 'Macro Analyst');
        } else {
          console.log(`✅ Macro Analyst successfully handed off to: ${nextAgentResult.nextAgent}`);
        }
      } else {
        // Failed to invoke next agent - fallback to coordinator
        console.log(`⚠️ Failed to invoke next agent, falling back to coordinator: ${nextAgentResult.error}`);
        notifyCoordinatorAsync(supabase, {
          analysisId,
          ticker,
          userId,
          phase: 'analysis',
          agent: 'macro-analyst',
          apiSettings,
          completionType: 'fallback_invocation_failed',
          failedToInvoke: nextAgentResult.intendedAgent,
          analysisContext: request.analysisContext
        }, 'Macro Analyst');
      }
    }

    console.log(`✅ Macro Analyst completed for ${ticker} (${retryStatus})`);

    return createSuccessResponse({
      agent: 'Macro Analyst',
      summary: agentOutput.summary,
      retryInfo: retryStatus
    });

  } catch (error) {
    // Clear timeout on error
    if (timeoutId !== null) {
      clearAgentTimeout(timeoutId, 'Macro Analyst', 'error occurred');
    }

    console.error('❌ Macro Analyst error:', error);

    // Determine the type of error and provide a helpful message
    if (error.message.includes('API key') || error.message.includes('api_key') || error.message.includes('invalid key')) {
      return createApiErrorResponse('AI Provider', 'key');
    } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
      return createApiErrorResponse('AI Provider', 'quota');
    } else if (error.message.includes('Perplefina') || error.message.includes('perplefina')) {
      return createApiErrorResponse('Perplefina', 'connection');
    } else if (error.message.includes('Supabase') || error.message.includes('database')) {
      return createErrorResponse('Database error occurred during macroeconomic analysis. Please try again.', 200);
    } else {
      return createErrorResponse(
        `Macroeconomic analysis failed: ${error.message}`,
        200,
        { agent: 'Macro Analyst' }
      );
    }
  }
});