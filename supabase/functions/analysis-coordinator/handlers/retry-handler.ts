import { ApiSettings } from '../types/index.ts';
import { createSuccessResponse, createErrorResponse } from '../utils/response-helpers.ts';
import { invokeWithRetry } from '../../_shared/invokeWithRetry.ts';
import { updateWorkflowStepStatus } from '../../_shared/atomicUpdate.ts';
import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';
import { attemptPhaseRecovery, findLastSuccessfulPhase, resumeFromPhase } from '../utils/error-recovery.ts';
import { checkPhaseHealth } from '../utils/phase-health-checker.ts';

/**
 * Retry a failed analysis by scanning workflow state and resuming from the first failed agent
 */
export async function retryFailedAnalysis(
  supabase: any,
  analysisId: string,
  userId: string,
  apiSettings: ApiSettings
): Promise<Response> {
  
  console.log(`🔄 Retry request for analysis: ${analysisId}`);
  
  try {
    // Fetch the failed analysis (security: ensure user owns this analysis)
    const { data: analysis, error: fetchError } = await supabase
      .from('analysis_history')
      .select('*')
      .eq('id', analysisId)
      .eq('user_id', userId)
      .single();
      
    if (fetchError || !analysis) {
      console.error('❌ Analysis not found:', fetchError?.message);
      return createErrorResponse('Analysis not found');
    }
    
    if (analysis.analysis_status !== ANALYSIS_STATUS.ERROR) {
      console.warn(`⚠️ Analysis ${analysisId} is not in error state: ${analysis.analysis_status}`);
      return createErrorResponse(
        `Cannot retry analysis that is not in error state. Current status: ${analysis.analysis_status}`
      );
    }
    
    // Additional check: prevent retrying cancelled analyses
    if (analysis.analysis_status === ANALYSIS_STATUS.CANCELLED) {
      console.warn(`⚠️ Analysis ${analysisId} was cancelled and cannot be retried`);
      return createErrorResponse(
        'Cannot retry cancelled analysis. Please start a new analysis instead.'
      );
    }
    
    console.log(`📋 Found failed analysis for ${analysis.ticker} - scanning for failed agent`);
    
    // First, try to identify which phase needs recovery
    const lastSuccessfulPhase = await findLastSuccessfulPhase(supabase, analysisId);
    console.log(`📊 Last successful phase: ${lastSuccessfulPhase || 'none'}`);
    
    // Find failed agent to retry
    const { retryAgent, retryPhase, retryAgentName, failedAgents } = await findFailedAgent(analysis);
    
    if (!retryAgent) {
      console.warn('⚠️ No failed agent found in workflow steps');
      
      // Try to resume from the beginning of the first incomplete phase
      const phases = ['analysis', 'research', 'trading', 'risk', 'portfolio'];
      for (const phase of phases) {
        const phaseHealth = await checkPhaseHealth(supabase, analysisId, phase);
        if (phaseHealth.pendingAgents > 0 || phaseHealth.failedAgents > 0) {
          console.log(`🔄 Attempting to resume from phase: ${phase}`);
          
          const resumeResult = await resumeFromPhase(
            supabase,
            analysisId,
            phase,
            analysis.ticker,
            userId,
            apiSettings,
            analysis.full_analysis?.analysisContext
          );
          
          if (resumeResult.success) {
            return createSuccessResponse({
              message: resumeResult.message,
              analysisId,
              phase,
              ticker: analysis.ticker
            });
          }
        }
      }
      
      return createErrorResponse(
        'No failed agent found to retry and unable to resume from any phase.',
        400
      );
    }
    
    console.log(`🎯 Found failed agent: ${retryAgent} in phase: ${retryPhase}`);
    
    // ALWAYS update analysis status from 'error' to 'running' when retrying
    console.log(`📝 Updating analysis status from error to running`);
    const { error: statusUpdateError } = await supabase
      .from('analysis_history')
      .update({ 
        analysis_status: ANALYSIS_STATUS.RUNNING,
        updated_at: new Date().toISOString()
      })
      .eq('id', analysisId);
    
    if (statusUpdateError) {
      console.error('❌ Failed to update analysis status:', statusUpdateError);
      return createErrorResponse('Failed to update analysis status for retry');
    }
    
    console.log(`✅ Updated analysis status to running`);
    
    // Reset the failed agent status to pending so it can be retried
    console.log(`🔄 Resetting ${retryAgentName} status from error to pending`);
    
    const stepUpdateResult = await updateWorkflowStepStatus(
      supabase,
      analysisId,
      retryPhase,
      retryAgentName,
      'pending'
    );
    
    if (!stepUpdateResult.success) {
      console.error(`❌ Failed to reset ${retryAgentName} status:`, stepUpdateResult.error);
    } else {
      console.log(`✅ Reset ${retryAgentName} status to pending`);
    }
    
    // Directly invoke the failed agent exactly as it would be invoked normally
    console.log(`🚀 Retrying ${retryAgentName} by directly invoking ${retryAgent}`);
    
    // Import invokeAgentWithRetry for direct agent invocation
    const { invokeAgentWithRetry } = await import('../../_shared/invokeWithRetry.ts');
    
    // Simply invoke the failed agent - it will continue the workflow naturally
    invokeAgentWithRetry(
      supabase,
      retryAgent,
      analysisId,
      analysis.ticker,
      userId,
      apiSettings,
      2, // maxRetries
      retryPhase
    );
    
    return createSuccessResponse({
      message: `Analysis retry started from ${retryAgentName}`,
      analysisId,
      phase: retryPhase,
      agent: retryAgent,
      ticker: analysis.ticker
    });
    
  } catch (error: any) {
    console.error('❌ Retry failed with error:', error);
    return createErrorResponse(
      `Failed to retry analysis: ${error.message}`,
      500
    );
  }
}


/**
 * Find the failed agent to retry from workflow steps
 */
async function findFailedAgent(analysis: any) {
  // Define critical agents that must succeed for analysis to be meaningful
  const criticalAgents = new Set([
    'agent-market-analyst',    // Core technical analysis - essential
    'agent-trader',           // Trading decision - essential  
    'agent-risk-manager',     // Final risk assessment - essential
    'analysis-portfolio-manager' // Portfolio execution - essential
  ]);
  
  // Define optional agents that can be skipped if they fail
  const optionalAgents = new Set([
    'agent-news-analyst',        // News analysis - helpful but not critical
    'agent-social-media-analyst', // Sentiment - helpful but not critical
    'agent-fundamentals-analyst', // Fundamentals - important but has fallbacks
    'agent-risky-analyst',       // Risk perspective - others can compensate
    'agent-safe-analyst',        // Risk perspective - others can compensate  
    'agent-neutral-analyst',     // Risk perspective - others can compensate
    'agent-bull-researcher',     // Research debate - can skip if needed
    'agent-bear-researcher'      // Research debate - can skip if needed
  ]);
  
  // Scan workflowSteps to find failed agents, prioritizing critical ones
  const workflowSteps = analysis.full_analysis?.workflowSteps || [];
  let failedAgents: Array<{
    phase: string;
    functionName: string;
    displayName: string;
    isCritical: boolean;
    isOptional: boolean;
    status: string;
    isStalePending: boolean;
  }> = [];
  
  // First pass: collect all failed and stale pending agents
  for (const phase of workflowSteps) {
    const agents = phase.agents || [];
    for (const agent of agents) {
      // Include agents with error status OR pending agents that are stale (> 5 minutes old) 
      // OR pending agents in portfolio phase (which often don't have updatedAt)
      const isError = agent.status === 'error';
      const isStalePending = agent.status === 'pending' && (
        (agent.updatedAt && Date.now() - new Date(agent.updatedAt).getTime() > 5 * 60 * 1000) ||
        (!agent.updatedAt && phase.id === 'portfolio') // Portfolio phase pending without updatedAt
      );
      
      if (isError || isStalePending) {
        // Special handling for Portfolio Manager function name
        let agentFunctionName = agent.functionName;
        if (!agentFunctionName) {
          if (agent.name === 'Portfolio Manager') {
            agentFunctionName = 'analysis-portfolio-manager';
          } else {
            agentFunctionName = `agent-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
          }
        }
        
        failedAgents.push({
          phase: phase.id,
          functionName: agentFunctionName,
          displayName: agent.name,
          isCritical: criticalAgents.has(agentFunctionName),
          isOptional: optionalAgents.has(agentFunctionName),
          status: agent.status,
          isStalePending
        });
      }
    }
  }
  
  if (failedAgents.length === 0) {
    return { retryAgent: null, retryPhase: null, retryAgentName: null, failedAgents: [] };
  }
  
  console.log(`📊 Found ${failedAgents.length} failed/stale agents:`, failedAgents.map(a => `${a.displayName} (${a.status === 'pending' ? 'stale pending' : a.status}, ${a.isCritical ? 'critical' : 'optional'})`));
  
  // Prioritize critical agents for retry
  let targetAgent = failedAgents.find(a => a.isCritical);
  if (!targetAgent) {
    // If no critical agents failed, retry the first optional agent
    targetAgent = failedAgents[0];
    console.log(`ℹ️ No critical agents failed, retrying optional agent: ${targetAgent.displayName}`);
  } else {
    console.log(`🎯 Retrying critical agent: ${targetAgent?.displayName}`);
  }
  
  if (!targetAgent) {
    // This shouldn't happen since we check failedAgents.length > 0 earlier
    throw new Error('No target agent found for retry');
  }
  
  return {
    retryAgent: targetAgent.functionName,
    retryPhase: targetAgent.phase,
    retryAgentName: targetAgent.displayName,
    failedAgents
  };
}