import { AnalysisContext, ApiSettings } from '../types/index.ts';
import { createSuccessResponse, createErrorResponse } from '../utils/response-helpers.ts';
import { invokeWithRetry, invokeAgentWithRetry } from '../../_shared/invokeWithRetry.ts';
import { updateAnalysisPhase, setAgentToError } from '../../_shared/atomicUpdate.ts';
import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';

/**
 * Handle portfolio routing decisions centralized in analysis-coordinator
 * This function routes the completed analysis to the portfolio manager
 */
export async function handlePortfolioRouting(
  supabase: any,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: ApiSettings,
  analysisContext: AnalysisContext
): Promise<Response> {
  
  console.log(`🎯 Portfolio routing for ${ticker}`);
  
  // Route all analyses to portfolio manager
  return await routeToPortfolioManager(
    supabase,
    analysisId,
    ticker,
    userId,
    apiSettings,
    analysisContext
  );
}

/**
 * Route individual analysis to analysis-portfolio-manager
 */
async function routeToPortfolioManager(
  supabase: any,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: ApiSettings,
  analysisContext: AnalysisContext
): Promise<Response> {
  
  console.log('📈 Individual analysis - routing to analysis-portfolio-manager');
  
  // Check if portfolio-manager has already been invoked for this analysis
  const { data: fullAnalysis } = await supabase
    .from('analysis_history')
    .select('full_analysis')
    .eq('id', analysisId)
    .single();
  
  const portfolioManagerStep = fullAnalysis?.full_analysis?.workflowSteps?.find((step: any) => 
    step.id === 'portfolio' || step.id === 'portfolio-manager'
  );
  
  if (portfolioManagerStep && portfolioManagerStep.status !== 'pending') {
    console.log('⚠️ Portfolio Manager already invoked for this analysis, skipping duplicate invocation');
    console.log(`  Current status: ${portfolioManagerStep.status}`);
    return createSuccessResponse({
      message: 'Portfolio routing completed - Portfolio Manager already invoked'
    });
  }
  
  console.log('✅ Portfolio Manager not yet invoked, proceeding with invocation');
  
  // Ensure portfolio phase exists in workflow steps
  if (!portfolioManagerStep) {
    console.log('📝 Creating portfolio phase in workflow steps');
    
    // Get current workflow steps and add portfolio phase if missing
    const currentSteps = fullAnalysis?.full_analysis?.workflowSteps || [];
    const portfolioPhase = {
      id: 'portfolio',
      name: 'Portfolio Management',
      status: 'pending',
      agents: [
        {
          name: 'Portfolio Manager',
          status: 'pending',
          functionName: 'analysis-portfolio-manager'
        }
      ]
    };
    
    // Add portfolio phase to workflow steps
    const updatedSteps = [...currentSteps, portfolioPhase];
    
    // Update the database with the new workflow steps
    const { error: updateError } = await supabase
      .from('analysis_history')
      .update({
        full_analysis: {
          ...fullAnalysis?.full_analysis,
          workflowSteps: updatedSteps
        }
      })
      .eq('id', analysisId);
    
    if (updateError) {
      console.error('❌ Failed to create portfolio phase in workflow steps:', updateError);
    } else {
      console.log('✅ Portfolio phase created in workflow steps');
    }
  }
  
  // Mark portfolio-manager as running before invoking to prevent duplicates
  const updateResult = await supabase.rpc('update_workflow_step_status', {
    p_analysis_id: analysisId,
    p_phase_id: 'portfolio',
    p_agent_name: 'Portfolio Manager',
    p_status: 'running'
  });
  
  if (!updateResult.data) {
    console.warn('⚠️ Failed to update portfolio manager status to running, but continuing with invocation');
  }
  
  // Route to analysis-portfolio-manager using invokeAgentWithRetry for proper settings handling
  // Fire-and-forget invocation of portfolio manager
  console.log('🚀 Invoking analysis-portfolio-manager with params:');
  console.log(`   analysisId: ${analysisId}`);
  console.log(`   ticker: ${ticker}`);
  console.log(`   userId: ${userId}`);
  console.log(`   apiSettings keys: ${apiSettings ? Object.keys(apiSettings).join(', ') : 'null'}`);
  console.log(`   phase: portfolio`);
  
  invokeAgentWithRetry(
      supabase,
      'analysis-portfolio-manager',
      analysisId,
      ticker,
      userId,
      apiSettings,
      2, // maxRetries
      'portfolio' // phase
      // analysisContext removed - not needed for agents
  );
  
  console.log('✅ analysis-portfolio-manager invocation initiated for individual analysis');
  
  return createSuccessResponse({
    message: 'Portfolio routing completed - analysis-portfolio-manager started'
  });
}
