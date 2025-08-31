import { RequestBody, ApiSettings, AnalysisContext } from '../types/index.ts';
import { fetchApiSettings } from '../utils/api-settings.ts';
import { checkAndHandleCancellation } from '../utils/cancellation-handler.ts';
import { fetchAnalysisData } from '../utils/analysis-fetcher.ts';
import { startSingleAnalysis } from './analysis-handler.ts';
import { handleAgentCompletion } from './agent-completion-handler.ts';
import { handlePortfolioRouting } from './portfolio-routing.ts';
import { retryFailedAnalysis } from './retry-handler.ts';
import { reactivateStaleAnalysis } from './reactivate-handler.ts';
import { initializePhase } from './phase-initialization.ts';
import { handleDebateRoundCompletion } from './debate-handler.ts';
import { 
  createOptionsResponse, createMethodNotAllowedResponse,
  createErrorResponse, createSuccessResponse,
} from '../utils/response-helpers.ts';
/**
 * Main request handler for the analysis-coordinator function
 * Handles individual stock analysis workflow requests
 */
export async function handleAnalysisRequest(
  req: Request,
  supabase: any
): Promise<Response> {
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return createOptionsResponse();
  }
  
  if (req.method !== 'POST') {
    return createMethodNotAllowedResponse();
  }
  
  try {
    const body: RequestBody = await req.json();
    const {
      action,
      analysisId,
      ticker,
      userId,
      phase,
      agent,
      analysisContext,
      useDefaultSettings,
      error,
      errorType,
      completionType,
      failedToInvoke,
      riskManagerDecision
    } = body;
    
    // Fetch API settings if userId is provided
    let apiSettings: ApiSettings | null = null;
    if (userId) {
      const { settings, error } = await fetchApiSettings(supabase, userId);
      if (error) return error;
      apiSettings = settings;
    }
    
    // Handle action-based requests (new pattern)
    if (action) {
      switch (action) {
        case 'start-analysis':
          if (!ticker || !userId || !apiSettings) {
            return createErrorResponse(
              'Missing required parameters for start-analysis',
              400
            );
          }
          return await startSingleAnalysis(supabase, userId, ticker, apiSettings, analysisContext);
          
        case 'reactivate':
          if (!analysisId || !userId || !apiSettings) {
            return createErrorResponse(
              'Missing required parameters for reactivate action',
              400
            );
          }
          // Extract forceReactivate flag from body if provided
          const forceReactivate = (body as any).forceReactivate === true;
          return await reactivateStaleAnalysis(supabase, analysisId, userId, apiSettings, forceReactivate);
          
        default:
          return createErrorResponse(`Unknown action: ${action}`);
      }
    }
    
    // Handle legacy requests (no phase/agent specified)
    if (!phase && !agent) {
      // Check if this is a retry request (has analysisId but no ticker)
      if (analysisId && !ticker) {
        if (!userId || !apiSettings) {
          return createErrorResponse(
            'Missing required parameters for retry request',
            400
          );
        }
        return await retryFailedAnalysis(supabase, analysisId, userId, apiSettings);
      }
      
      // Otherwise it's a new analysis request
      if (!ticker || !userId || !apiSettings) {
        return createErrorResponse(
          'Missing required parameters for new analysis',
          400
        );
      }
      return await startSingleAnalysis(supabase, userId, ticker, apiSettings);
    }
    
    // Handle agent callbacks
    if (!analysisId || !ticker || !userId || !phase || !apiSettings) {
      return createErrorResponse(
        'Missing required parameters for agent callback',
        400
      );
    }
    
    return await handleAgentCallback(
      supabase,
      analysisId,
      ticker,
      userId,
      phase,
      agent,
      apiSettings,
      analysisContext,
      error,
      errorType,
      completionType,
      failedToInvoke
    );
    
  } catch (error: any) {
    console.error('❌ Request handling error:', error);
    return createErrorResponse(
      error.message || 'Internal server error'
    );
  }
}

/**
 * Handle agent callback requests for individual stock analysis
 */
async function handleAgentCallback(
  supabase: any,
  analysisId: string,
  ticker: string,
  userId: string,
  phase: string,
  agent: string | undefined,
  apiSettings: ApiSettings,
  analysisContext?: AnalysisContext,
  error?: string,
  errorType?: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'other',
  completionType?: 'normal' | 'last_in_phase' | 'fallback_invocation_failed',
  failedToInvoke?: string
): Promise<Response> {
  
  console.log(`🎯 Analysis coordinator callback: phase=${phase}, agent=${agent}, context=${analysisContext?.type || 'individual'}`);
  
  // Check cancellation status
  const cancellationResponse = await checkAndHandleCancellation(supabase, analysisId, analysisContext);
  if (cancellationResponse) {
    return cancellationResponse;
  }
  
  // Get current analysis state
  const { analysis, fullAnalysis } = await fetchAnalysisData(supabase, analysisId) || {};
  
  // Handle research debate rounds
  if (phase === 'research' && agent === 'check-debate-rounds') {
    return await handleDebateRoundCompletion(
      supabase,
      analysisId,
      ticker,
      userId,
      apiSettings,
      fullAnalysis,
      analysisContext
    );
  }
  
  // Handle agent completion
  if (agent) {
    return await handleAgentCompletion(
      supabase,
      phase,
      agent,
      analysisId,
      ticker,
      userId,
      apiSettings,
      analysisContext,
      error,
      errorType,
      completionType,
      failedToInvoke
    );
  }
  
  // Start new phase by launching its first agent
  if (phase === 'portfolio') {
    // Handle portfolio routing decisions from risk completion
    if (analysisContext?.source === 'risk-completion') {
      return await handlePortfolioRouting(
        supabase,
        analysisId,
        ticker,
        userId,
        apiSettings,
        analysisContext
      );
    }
    
    // Portfolio Manager has completed - this is the final step for individual analyses
    console.log('🎆 Portfolio Manager completed - analysis workflow finished');
    
    return createSuccessResponse({
      message: 'Portfolio Manager completed - analysis workflow finished',
      analysisComplete: true
    });
  }
  
  // Initialize other phases
  return await initializePhase(
    supabase,
    phase,
    analysisId,
    ticker,
    userId,
    apiSettings,
    analysisContext
  );
}
