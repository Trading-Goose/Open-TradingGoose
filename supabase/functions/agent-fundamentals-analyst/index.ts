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

// Extended interface for Fundamentals Analyst specific settings
interface FundamentalsAnalystRequest extends AgentRequest {
  apiSettings: AgentRequest['apiSettings'] & {
    ai_provider: string;
    ai_api_key: string;
    ai_model?: string;
    analysis_optimization?: string;
    analysis_max_tokens?: number;
  };
}

serve(async (req) => {
  let timeoutId: number | null = null;

  try {
    if (req.method !== 'POST') {
      return createMethodNotAllowedResponse();
    }

    const request: FundamentalsAnalystRequest = await req.json();
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
    console.log(`📊 Fundamentals Analyst starting for ${ticker} (${retryStatus})`);

    // Setup timeout with self-retry mechanism
    timeoutId = setupAgentTimeout(
      supabase,
      request,
      {
        functionName: 'agent-fundamentals-analyst',
        maxRetries: 3,
        timeoutMs: 180000,
        retryDelay: 3000   // 3 second delay between retries
      },
      'Fundamentals Analyst'
    );
    console.log(`🤖 Using AI: ${apiSettings.ai_provider || 'openai'} | Model: ${apiSettings.ai_model || 'default'}`);

    // Check if analysis has been canceled before starting work
    const cancellationCheck = await checkAnalysisCancellation(supabase, analysisId);
    if (!cancellationCheck.shouldContinue) {
      console.log(`🛑 Fundamentals Analyst stopped: ${cancellationCheck.reason}`);
      return createCanceledResponse(
        `Fundamentals Analyst stopped: ${cancellationCheck.reason}`,
        cancellationCheck.isCanceled
      );
    }

    // Check if analysis still exists by trying to update it (deletion check)
    const updateResult = await updateAnalysisPhase(supabase, analysisId, 'Fundamentals Analyst analyzing', {
      agent: 'Fundamentals Analyst',
      message: 'Starting fundamental analysis',
      timestamp: new Date().toISOString(),
      type: 'info'
    });

    // If analysis phase update fails, it likely means analysis was deleted
    if (!updateResult.success) {
      console.log(`🛑 Fundamentals Analyst stopped: ${updateResult.error}`);
      return createCanceledResponse(
        `Fundamentals Analyst stopped: ${updateResult.error}`,
        true
      );
    }

    // Update analysis status
    await updateAnalysisPhase(supabase, analysisId, 'Fundamentals Analyst evaluating financials', {
      agent: 'Fundamentals Analyst',
      message: 'Analyzing financial statements and metrics using Perplefina',
      timestamp: new Date().toISOString(),
      type: 'info'
    });

    // Map optimization mode to source count
    const optimizationMode = apiSettings.analysis_optimization || 'normal';
    const maxSources = optimizationMode === 'balanced' ? 15 : 10;

    console.log(`📊 Using optimization: ${optimizationMode} with ${maxSources} sources`);

    // Call Perplefina API for fundamental analysis
    let aiResponse = '';
    let agentError = null;
    let perplefinaData = null;

    try {
      const data = await callPerplefina({
        focusMode: 'fundamentals',
        query: `Comprehensive fundamental analysis for ${ticker} stock including financial statements, valuation, growth prospects, and investment recommendation`,
        optimizationMode: optimizationMode,
        maxSources: maxSources,
        chatModel: {
          provider: apiSettings.ai_provider,
          model: apiSettings.ai_model || 'default',
          apiKey: apiSettings.ai_api_key
        },
        maxTokens: apiSettings.analysis_max_tokens || 1200,
        systemInstructions: `You are a fundamental analyst for ${ticker}. Provide comprehensive analysis including: 1) Valuation assessment (P/E, PEG, EV/EBITDA), 2) Financial health evaluation, 3) Growth prospects analysis, 4) Cash flow assessment, 5) Key strengths/weaknesses, 6) Sector comparison, 7) Investment recommendation. Based on your fundamental analysis, provide a clear BUY/SELL/HOLD recommendation with supporting rationale. Append a Markdown table organizing: Valuation Status, Financial Health Grade, Growth Outlook, Fundamental Recommendation (BUY/SELL/HOLD), Key Risk Factors.`
      });

      aiResponse = data.message || 'No analysis content received from Perplefina';
      perplefinaData = data.sources || [];

    } catch (aiError) {
      console.error('❌ Perplefina call failed:', aiError);
      agentError = aiError.message || 'Failed to get Perplefina response';
      aiResponse = `Error: Unable to complete fundamental analysis due to Perplefina error.

Error details: ${agentError}

Please retry the analysis or check your Perplefina configuration.`;
    }

    // Calculate fundamental score based on available data
    const fundamentalScore = 50; // Default score when using Perplexica

    // Save agent output (even if there was an error)
    const agentOutput = {
      agent: 'Fundamentals Analyst',
      timestamp: new Date().toISOString(),
      sources: perplefinaData,
      analysis: aiResponse,
      error: agentError,
      fundamentalScore: agentError ? 0 : fundamentalScore
    };

    // Update analysis atomically to prevent race conditions
    console.log('💾 Updating analysis results atomically...');
    console.log(`📊 Fundamentals insight size: ${JSON.stringify(agentOutput).length} chars`);

    // Handle agent completion - either success or error
    if (agentError) {
      // Set agent to error status using the new helper function
      const errorResult = await setAgentToError(
        supabase,
        analysisId,
        'analysis',
        'Fundamentals Analyst',
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
    } else {
      // Update agent insights atomically for successful completion
      try {
        const insightsResult = await updateAgentInsights(supabase, analysisId, 'fundamentalsAnalyst', agentOutput);
        if (insightsResult && !insightsResult.success) {
          console.error('❌ Failed to update insights:', insightsResult.error);
          // Try a simpler update with just the analysis text
          console.log('🔄 Attempting fallback update with simplified data...');
          const simplifiedInsight = {
            analysis: aiResponse,
            timestamp: new Date().toISOString()
          };
          const fallbackResult = await updateAgentInsights(supabase, analysisId, 'fundamentalsAnalyst', simplifiedInsight);
          if (fallbackResult && !fallbackResult.success) {
            console.error('❌ Fallback update also failed:', fallbackResult.error);
          } else {
            console.log('✅ Fallback update succeeded');
          }
        } else {
          console.log('✅ Agent insights updated successfully');
        }
      } catch (error) {
        console.error('❌ Exception during insights update:', error);
        // Continue anyway - at least the message will be saved
      }

      // Append message atomically
      const messageResult = await appendAnalysisMessage(
        supabase,
        analysisId,
        'Fundamentals Analyst',
        aiResponse,
        'analysis'
      );
      if (messageResult && !messageResult.success) {
        console.error('Failed to append message:', messageResult.error);
      }

      // Update workflow step status to completed and wait for confirmation
      const statusResult = await updateWorkflowStepStatus(
        supabase,
        analysisId,
        'analysis',
        'Fundamentals Analyst',
        'completed'
      );
      if (statusResult && !statusResult.success) {
        console.error('Failed to update workflow status:', statusResult.error);
      } else {
        console.log('✅ Workflow status updated to completed for Fundamentals Analyst');
      }
    }

    console.log('✅ Fundamentals Analyst data saved successfully');

    // Clear timeout on successful completion
    if (timeoutId !== null) {
      clearAgentTimeout(timeoutId, 'Fundamentals Analyst', 'completed successfully');
    }

    // Only invoke next agent if this agent completed successfully
    if (agentError) {
      // Notify coordinator about the error - do NOT invoke next agent
      console.log(`⚠️ Fundamentals Analyst completed with errors - notifying coordinator, NOT invoking next agent`);
      notifyCoordinatorAsync(supabase, {
        analysisId,
        ticker,
        userId,
        phase: 'analysis',
        agent: 'fundamentals-analyst',
        apiSettings,
        error: agentError,
        errorType: agentError.includes('rate limit') || agentError.includes('quota') ? 'rate_limit' :
          agentError.includes('API key') || agentError.includes('invalid key') || agentError.includes('api_key') ? 'api_key' :
            agentError.includes('Perplefina') || agentError.includes('perplefina') ? 'data_fetch' :
              agentError.includes('AI provider') || agentError.includes('No API key provided') ? 'ai_error' : 'other',
        completionType: 'error',
        analysisContext: request.analysisContext
      }, 'Fundamentals Analyst');
    } else {
      // Success case - invoke next agent
      console.log(`🔄 Fundamentals Analyst attempting to invoke next agent in analysis phase...`);

      const nextAgentResult = await invokeNextAgentInSequence(
        supabase,
        analysisId,
        'analysis',
        'fundamentals-analyst',
        ticker,
        userId,
        apiSettings,
        request.analysisContext
      );

      if (nextAgentResult.success) {
        if (nextAgentResult.isLastInPhase) {
          // We're the last agent in analysis phase - notify coordinator for phase transition
          console.log(`📋 Fundamentals Analyst is last in analysis phase - verifying status before notifying coordinator`);

          // Verify the status update has been persisted before notifying coordinator
          const { data: verifyData, error: verifyError } = await supabase
            .from('analysis_history')
            .select('full_analysis')
            .eq('id', analysisId)
            .single();

          if (!verifyError && verifyData) {
            const workflowSteps = verifyData.full_analysis?.workflowSteps || [];
            const analysisPhase = workflowSteps.find((s: any) => s.id === 'analysis');
            const fundamentalsAgent = analysisPhase?.agents?.find((a: any) => a.name === 'Fundamentals Analyst');

            if (fundamentalsAgent?.status === 'completed') {
              console.log(`✅ Verified Fundamentals Analyst status is 'completed' - now notifying coordinator`);
            } else {
              console.warn(`⚠️ Status verification shows: ${fundamentalsAgent?.status || 'not found'} - proceeding anyway`);
            }
          }

          notifyCoordinatorAsync(supabase, {
            analysisId,
            ticker,
            userId,
            phase: 'analysis',
            agent: 'fundamentals-analyst',
            apiSettings,
            completionType: 'last_in_phase',
            analysisContext: request.analysisContext
          }, 'Fundamentals Analyst');
        } else {
          console.log(`✅ Fundamentals Analyst successfully handed off to: ${nextAgentResult.nextAgent}`);
        }
      } else {
        // Failed to invoke next agent - fallback to coordinator
        console.log(`⚠️ Failed to invoke next agent, falling back to coordinator: ${nextAgentResult.error}`);
        notifyCoordinatorAsync(supabase, {
          analysisId,
          ticker,
          userId,
          phase: 'analysis',
          agent: 'fundamentals-analyst',
          apiSettings,
          completionType: 'fallback_invocation_failed',
          failedToInvoke: nextAgentResult.intendedAgent,
          analysisContext: request.analysisContext
        }, 'Fundamentals Analyst');
      }
    }

    console.log(`✅ Fundamentals Analyst completed for ${ticker} (${retryStatus})`);

    return createSuccessResponse({
      agent: 'Fundamentals Analyst',
      summary: agentOutput.summary,
      retryInfo: retryStatus
    });

  } catch (error) {
    // Clear timeout on error
    if (timeoutId !== null) {
      clearAgentTimeout(timeoutId, 'Fundamentals Analyst', 'error occurred');
    }

    console.error('❌ Fundamentals Analyst error:', error);

    // Determine the type of error and provide a helpful message
    if (error.message.includes('API key') || error.message.includes('api_key') || error.message.includes('invalid key')) {
      return createApiErrorResponse('AI Provider', 'key');
    } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
      return createApiErrorResponse('AI Provider', 'quota');
    } else if (error.message.includes('Perplefina') || error.message.includes('perplefina')) {
      return createApiErrorResponse('Perplefina', 'connection');
    } else if (error.message.includes('Supabase') || error.message.includes('database')) {
      return createErrorResponse('Database error occurred during fundamental analysis. Please try again.', 200);
    } else {
      return createErrorResponse(
        `Fundamental analysis failed: ${error.message}`,
        200,
        { agent: 'Fundamentals Analyst' }
      );
    }
  }
});