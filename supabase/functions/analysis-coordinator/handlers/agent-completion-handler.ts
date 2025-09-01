import { ApiSettings, AnalysisContext } from '../types/index.ts';
import { createSuccessResponse, createErrorResponse } from '../utils/response-helpers.ts';
import { handlePhaseCompletion } from './phase-completion.ts';
import { handleFailedInvocationFallback } from '../utils/phase-manager.ts';
import { handleRiskManagerCompletion } from './risk-completion.ts';
import { handleBearResearcherCompletion } from './research-completion.ts';
import { 
  categorizeAgentError, 
  shouldContinueAfterError,
  checkPhaseHealth 
} from '../utils/phase-health-checker.ts';
import { markAnalysisAsError } from '../utils/analysis-error-handler.ts';

/**
 * Handle agent completion and workflow coordination for individual stock analysis
 */
export async function handleAgentCompletion(
  supabase: any,
  phase: string,
  agent: string,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: ApiSettings,
  analysisContext?: AnalysisContext,
  error?: string,
  errorType?: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'other',
  completionType?: 'normal' | 'last_in_phase' | 'fallback_invocation_failed' | 'agent_error',
  failedToInvoke?: string
): Promise<Response> {
  
  if (error) {
    console.log(`⚠️ Agent ${agent} completed with error in phase ${phase}: ${error}`);
    console.log(`   Error type: ${errorType || 'unknown'}`);
    
    // Categorize the error to determine its severity
    const errorCategory = categorizeAgentError(agent, errorType);
    console.log(`   Error category:`, errorCategory);
    
    // Store the error in the database for tracking
    try {
      await supabase.rpc('update_agent_error', {
        p_analysis_id: analysisId,
        p_agent_name: agent,
        p_error_message: error,
        p_error_type: errorType || 'other'
      });
    } catch (err: any) {
      // If RPC doesn't exist, fall back to direct update
      console.log('Falling back to direct error update:', err.message);
      try {
        await supabase
          .from('analysis_history')
          .update({
            agent_insights: supabase.raw(`
              agent_insights || jsonb_build_object(
                '${agent}_error', jsonb_build_object(
                  'message', '${error.replace(/'/g, "''")}',
                  'type', '${errorType || 'other'}',
                  'timestamp', '${new Date().toISOString()}'
                )
              )
            `)
          })
          .eq('id', analysisId);
      } catch (fallbackErr: any) {
        console.error('Error updating agent error in database:', fallbackErr);
      }
    }
    
    // Mark the agent as completed with error in workflow
    try {
      await supabase.rpc('update_workflow_step_status', {
        p_analysis_id: analysisId,
        p_phase_id: phase,
        p_agent_name: agent.split('-').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
        p_status: 'error'
      });
    } catch (err: any) {
      console.error('Error updating workflow step status for failed agent:', err);
    }
    
    // Special handling for research manager failure - it should continue to trading phase
    if (agent === 'agent-research-manager' && phase === 'research') {
      console.log(`📊 Research Manager failed - marking as error but continuing to trading phase`);
      
      // Research Manager is not critical - we can continue with the debate results
      // Continue to trading phase despite Research Manager failure
      return await handlePhaseCompletion(
        supabase, 
        'research', 
        agent, 
        analysisId, 
        ticker, 
        userId, 
        apiSettings, 
        analysisContext
      );
    }
    
    // Special handling for bull/bear researcher failures
    if (agent === 'agent-bull-researcher' || agent === 'agent-bear-researcher') {
      console.log(`🔍 ${agent} failed - checking if we have any debate rounds`);
      
      // Check if we have at least one completed debate round
      const { data: analysis } = await supabase
        .from('analysis_history')
        .select('full_analysis')
        .eq('id', analysisId)
        .single();
      
      const debateRounds = analysis?.full_analysis?.debateRounds || [];
      const completedRounds = debateRounds.filter((round: any) => 
        round.bull && round.bear
      );
      
      console.log(`📊 Debate status: ${completedRounds.length} complete rounds`);
      
      // We need at least ONE complete round (both bull AND bear) to proceed
      if (completedRounds.length === 0) {
        console.log(`❌ No complete debate rounds (need both bull AND bear) - cannot proceed without proper research debate`);
        
        // Use unified helper to mark analysis as error
        const errorResult = await markAnalysisAsError(
          supabase,
          analysisId,
          ticker,
          userId,
          apiSettings,
          `Research phase failed - no debate rounds completed due to ${agent} failure`,
          { decision: 'PENDING', confidence: 0 }  // Use PENDING for failed analyses
        );
        
        if (!errorResult.success) {
          console.error(`❌ Failed to mark analysis as ERROR:`, errorResult.error);
        } else {
          console.log(`✅ Analysis marked as ERROR successfully`);
        }
        
        return createErrorResponse(
          `Research phase failed - ${agent} failed and no debate rounds were completed`,
          500
        );
      } else {
        console.log(`✅ Have ${completedRounds.length} complete debate round(s) - proceeding to research manager`);
        
        // Skip to research manager since we have at least one debate round
        const { invokeAgentWithRetry } = await import('../../_shared/invokeWithRetry.ts');
        
        console.log(`🚀 Invoking research manager directly due to ${agent} failure`);
        invokeAgentWithRetry(
          supabase,
          'agent-research-manager',
          analysisId,
          ticker,
          userId,
          apiSettings,
          2, // maxRetries
          'research'
        );
        
        return createSuccessResponse({
          message: `${agent} failed but proceeding with ${completedRounds.length} debate rounds to research manager`,
          analysisId,
          phase: 'research',
          decision: 'skip_to_research_manager'
        });
      }
    }
    
    // Check if we should continue after this error
    const isLastAgent = completionType === 'last_in_phase';
    const { shouldContinue, reason } = await shouldContinueAfterError(
      supabase,
      analysisId,
      phase,
      agent,
      errorType,
      isLastAgent
    );
    
    console.log(`📊 Error continuation decision: ${shouldContinue ? 'CONTINUE' : 'STOP'} - ${reason}`);
    
    // Handle workflow-stopping errors
    if (!shouldContinue && errorCategory.shouldStopWorkflow) {
      console.log(`❌ Critical failure in ${agent} - stopping workflow`);
      
      // Use unified helper to mark analysis as error
      const errorResult = await markAnalysisAsError(
        supabase,
        analysisId,
        ticker,
        userId,
        apiSettings,
        `${agent} failed: ${error}`,
        { decision: 'PENDING', confidence: 0 }  // Use PENDING for failed analyses
      );
      
      if (!errorResult.success) {
        console.error(`❌ Failed to mark analysis as ERROR:`, errorResult.error);
      } else {
        console.log(`✅ Analysis marked as ERROR successfully`);
      }
      
      return createErrorResponse(`${agent} failed critically - ${reason}`);
    }
    
    // Phase-stopping errors when this is the last agent
    if (!shouldContinue && isLastAgent) {
      console.log(`⚠️ Phase ${phase} cannot proceed - ${reason}`);
      
      // Don't transition to next phase
      return createSuccessResponse({
        message: `Phase ${phase} stopped due to errors`,
        error: true,
        phaseCompleted: false,
        reason
      });
    }
    
    // Continue with workflow despite error
    console.log(`📊 Continuing workflow despite ${agent} error`);
    
    // When an agent has an error, we need to invoke the next agent in the phase
    // Import the helper functions
    const { getNextAgentInPhase } = await import('../utils/phase-manager.ts');
    const { invokeAgentWithRetry } = await import('../../_shared/invokeWithRetry.ts');
    
    const nextAgent = getNextAgentInPhase(phase, agent);
    
    if (nextAgent) {
      console.log(`🔄 Agent ${agent} had error - coordinator will invoke next agent: ${nextAgent}`);
      
      // Directly invoke the next agent (not using fallback handler which is for a different scenario)
      // Fire-and-forget invocation of next agent after error
      invokeAgentWithRetry(
        supabase,
        nextAgent,
        analysisId,
        ticker,
        userId,
        apiSettings,
        2, // maxRetries
        phase // phase parameter
        // analysisContext removed - not needed for agents
      );
      
      console.log(`✅ Successfully started ${nextAgent} after ${agent} error`);
      return createSuccessResponse({
        message: `Continued to ${nextAgent} after ${agent} error`,
        continuedAfterError: true,
        nextAgent
      });
    } else {
      // This was the last agent in the phase
      console.log(`📋 Agent ${agent} was last in phase ${phase} and had an error`);
      // Set completion type to handle phase transition check
      completionType = 'last_in_phase';
      // Continue to the completion type routing below
    }
  } else {
    console.log(`✅ Agent ${agent} completed successfully in phase ${phase}`);
  }
  
  // Only handle specific agent completions if they completed successfully (no error)
  if (!error) {
    // Handle specific agent completions that need special logic
    if (agent === 'risk-manager') {
      return await handleRiskManagerCompletion(supabase, analysisId, analysisContext, ticker, userId, apiSettings);
    }
    
    if (agent === 'bear-researcher') {
      return await handleBearResearcherCompletion(supabase, analysisId, ticker, userId, apiSettings);
    }
  }
  
  // Route based on completion type - this is the critical fix
  console.log(`🔀 Routing agent completion: type=${completionType || 'default'}, agent=${agent}, phase=${phase}`);
  
  if (completionType === 'agent_error') {
    // Agent had an error and notified coordinator via setAgentToError
    // The error handling logic above should have already processed this
    console.log(`⚠️ Agent error completion type - error already handled, not advancing phase`);
    
    // If we get here, the error handling above should have either:
    // 1. Stopped the workflow (critical error)
    // 2. Invoked the next agent (non-critical error)
    // 3. Set completionType to 'last_in_phase' if it was the last agent
    
    // This is a safety check - we should not advance phases on agent_error
    return createSuccessResponse({
      message: `Agent ${agent} error handled`,
      error: true,
      completionType: 'agent_error'
    });
    
  } else if (completionType === 'fallback_invocation_failed') {
    // Agent failed to invoke next agent - coordinator takes over as fallback
    console.log(`🔄 FALLBACK DETECTED: ${agent} failed to invoke next agent, coordinator handling fallback`);
    
    if (!failedToInvoke) {
      console.error(`❌ Fallback scenario but no failedToInvoke specified`);
      return createErrorResponse('Fallback scenario detected but no failed agent specified');
    }
    
    return await handleFailedInvocationFallback(
      supabase, phase, agent, failedToInvoke, analysisId, ticker, userId, apiSettings, analysisContext
    );
    
  } else if (completionType === 'last_in_phase') {
    // Agent is explicitly the last in phase - check phase health before transitioning
    console.log(`🔍 Last agent in phase: ${agent} completed - checking phase health`);
    
    // Check if the phase is healthy enough to proceed
    const phaseHealth = await checkPhaseHealth(supabase, analysisId, phase);
    console.log(`📊 Phase health check:`, phaseHealth);
    
    if (!phaseHealth.canProceed) {
      console.log(`❌ Phase ${phase} cannot proceed: ${phaseHealth.reason}`);
      
      // Mark analysis as error if:
      // 1. Critical failures prevent continuation
      // 2. Research phase can't proceed (no debate content)
      // 3. Trading phase failed (critical for decision)
      if (phaseHealth.criticalFailures.length > 0 || 
          phase === 'research' || 
          phase === 'trading') {
        // Use unified helper to mark analysis as error
        const errorResult = await markAnalysisAsError(
          supabase,
          analysisId,
          ticker,
          userId,
          apiSettings,
          `Phase ${phase} failed: ${phaseHealth.reason}`
        );
        
        if (!errorResult.success) {
          console.error(`❌ Failed to mark analysis as ERROR:`, errorResult.error);
        } else {
          console.log(`✅ Analysis marked as ERROR successfully`);
        }
      }
      
      return createSuccessResponse({
        message: `Phase ${phase} cannot proceed due to failures`,
        error: true,
        phaseCompleted: false,
        phaseHealth,
        reason: phaseHealth.reason
      });
    }
    
    console.log(`✅ Phase ${phase} is healthy - proceeding with transition`);
    return await handlePhaseCompletion(supabase, phase, agent, analysisId, ticker, userId, apiSettings, analysisContext);
    
  } else {
    // Default behavior for backward compatibility and unclear cases
    console.log(`📋 Default completion handling for ${agent} in ${phase} phase`);
    
    // For backward compatibility, if no completion type is specified, 
    // assume it's a legitimate phase completion (old behavior)
    return await handlePhaseCompletion(supabase, phase, agent, analysisId, ticker, userId, apiSettings, analysisContext);
  }
}