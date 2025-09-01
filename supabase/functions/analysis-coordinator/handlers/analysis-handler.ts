import { ApiSettings, AnalysisContext } from '../types/index.ts';
import { createErrorResponse, createSuccessResponse } from '../utils/response-helpers.ts';
import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';
import { markAnalysisAsError } from '../utils/analysis-error-handler.ts';

/**
 * Start a single stock analysis with optional context
 */
export async function startSingleAnalysis(
  supabase: any,
  userId: string,
  ticker: string,
  apiSettings: ApiSettings,
  analysisContext?: AnalysisContext
): Promise<Response> {
  console.log(`🚀 Creating analysis record for ${ticker}`);
  
  // Validate ticker format
  if (!/^[A-Z0-9.-]+$/.test(ticker)) {
    return createErrorResponse(
      'Invalid ticker symbol format',
      400
    );
  }
  
  const { data: runningAnalyses } = await supabase
    .from('analysis_history')
    .select('id, full_analysis, created_at')
    .eq('user_id', userId)
    .eq('ticker', ticker)
    .in('analysis_status', [ANALYSIS_STATUS.PENDING, ANALYSIS_STATUS.RUNNING])
    .order('created_at', { ascending: false });
  
  let analysis;
  if (runningAnalyses && runningAnalyses.length > 0) {
    analysis = runningAnalyses[0];
    console.log(`⚠️ Found existing pending/running analysis for ${ticker}, reusing ID: ${analysis.id}`);
    
    
    if (runningAnalyses.length > 1) {
      const orphanedIds = runningAnalyses.slice(1).map((a: any) => a.id);
      console.log(`🧹 Cleaning up ${orphanedIds.length} orphaned pending/running analyses for ${ticker}`);
      
      
      // Update all orphaned analyses using unified helper
      for (const orphanedId of orphanedIds) {
        const errorResult = await markAnalysisAsError(
          supabase,
          orphanedId,
          ticker,
          userId,
          apiSettings,
          'Analysis superseded by newer request'
        );
        
        if (!errorResult.success) {
          console.error(`❌ Failed to mark orphaned analysis ${orphanedId} as ERROR:`, errorResult.error);
        } else {
          console.log(`✅ Orphaned analysis ${orphanedId} marked as ERROR`);
        }
      }
    }
  } else {
    // Create new analysis record
    const insertData: any = {
      user_id: userId,
      ticker,
      analysis_date: new Date().toISOString().split('T')[0],
      decision: 'PENDING',
      confidence: 0,
      agent_insights: {},
      analysis_status: ANALYSIS_STATUS.PENDING,
      full_analysis: createInitialWorkflowSteps()
    };
    
    
    const { data: newAnalysis, error } = await supabase
      .from('analysis_history')
      .insert(insertData)
      .select()
      .single();
    
    if (error) {
      console.error(`❌ Failed to create analysis for ${ticker}:`, error);
      return createErrorResponse(error.message);
    }
    
    if (!newAnalysis) {
      console.error('❌ No analysis record returned after insert');
      return createErrorResponse('Failed to create analysis record');
    }
    
    analysis = newAnalysis;
    console.log(`✅ Created new analysis record for ${ticker}, ID: ${analysis.id}`);
  }
  
  // Call the analysis-coordinator (this same function) to start the workflow
  const coordinatorResponse = await supabase.functions.invoke('analysis-coordinator', {
    body: {
      analysisId: analysis.id,
      ticker,
      userId,
      phase: 'analysis',
      apiSettings,
      analysisContext: analysisContext || { type: 'individual' }
    }
  });
  
  if (coordinatorResponse.error) {
    console.error('❌ Failed to start coordinator workflow:', coordinatorResponse.error);
    
    // Use unified helper to mark analysis as error
    const errorResult = await markAnalysisAsError(
      supabase,
      analysis.id,
      ticker,
      userId,
      apiSettings,
      `Failed to start coordinator workflow: ${coordinatorResponse.error.message}`
    );
    
    if (!errorResult.success) {
      console.error(`❌ Failed to mark analysis as ERROR:`, errorResult.error);
    } else {
      console.log(`✅ Analysis marked as ERROR successfully`);
    }
    
    return createErrorResponse(
      `Failed to start coordinator workflow: ${coordinatorResponse.error.message}`
    );
  }
  console.log('✅ Coordinator workflow initiated successfully');
  
  return createSuccessResponse({
    analysisId: analysis.id,
    message: 'Analysis workflow started - will complete in multiple phases',
    workflow: 'chunked'
  });
}

/**
 * Create initial workflow steps structure for new analysis
 */
function createInitialWorkflowSteps() {
  const pendingAgent = { status: 'pending', progress: 0 };
  
  return {
    // Remove status from full_analysis - use analysis_status field instead
    startedAt: new Date().toISOString(),
    messages: [],
    workflowSteps: [
      {
        id: 'analysis',
        name: 'Market Analysis',
        status: 'pending',
        agents: [
          { name: 'Macro Analyst', functionName: 'agent-macro-analyst', ...pendingAgent },
          { name: 'Market Analyst', functionName: 'agent-market-analyst', ...pendingAgent },
          { name: 'News Analyst', functionName: 'agent-news-analyst', ...pendingAgent },
          { name: 'Social Media Analyst', functionName: 'agent-social-media-analyst', ...pendingAgent },
          { name: 'Fundamentals Analyst', functionName: 'agent-fundamentals-analyst', ...pendingAgent }
        ]
      },
      {
        id: 'research',
        name: 'Research Team',
        status: 'pending',
        agents: [
          { name: 'Bull Researcher', functionName: 'agent-bull-researcher', ...pendingAgent },
          { name: 'Bear Researcher', functionName: 'agent-bear-researcher', ...pendingAgent },
          { name: 'Research Manager', functionName: 'agent-research-manager', ...pendingAgent }
        ]
      },
      {
        id: 'trading',
        name: 'Trading Decision',
        status: 'pending',
        agents: [{ name: 'Trader', functionName: 'agent-trader', ...pendingAgent }]
      },
      {
        id: 'risk',
        name: 'Risk Management',
        status: 'pending',
        agents: [
          { name: 'Risky Analyst', functionName: 'agent-risky-analyst', ...pendingAgent },
          { name: 'Safe Analyst', functionName: 'agent-safe-analyst', ...pendingAgent },
          { name: 'Neutral Analyst', functionName: 'agent-neutral-analyst', ...pendingAgent },
          { name: 'Risk Manager', functionName: 'agent-risk-manager', ...pendingAgent }
        ]
      },
      {
        id: 'portfolio',
        name: 'Portfolio Management',
        status: 'pending',
        agents: [{ name: 'Portfolio Manager', functionName: 'analysis-portfolio-manager', ...pendingAgent }]
      }
    ]
  };
}