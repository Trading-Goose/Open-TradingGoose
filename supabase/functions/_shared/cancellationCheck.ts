/**
 * Cancellation check utilities for Supabase Edge Functions
 * Prevents agents from continuing work on canceled analyses
 */

import { ANALYSIS_STATUS } from './statusTypes.ts';

export interface CancellationResult {
  isCanceled: boolean;
  shouldContinue: boolean;
  reason?: string;
}

/**
 * Check if an analysis has been canceled by the user
 * @param supabase - Supabase client
 * @param analysisId - Analysis ID to check
 * @returns CancellationResult indicating if analysis should continue
 */
export async function checkAnalysisCancellation(
  supabase: any,
  analysisId: string
): Promise<CancellationResult> {
  try {
    console.log(`🔍 Checking cancellation status for analysis ${analysisId}`);
    
    const { data: analysis, error } = await supabase
      .from('analysis_history')
      .select('analysis_status')
      .eq('id', analysisId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // Check if it's a duplicate issue
      if (error.message?.includes('multiple')) {
        console.warn('⚠️ Multiple analyses found with same ID - using most recent');
        // Try again without .single() to handle duplicates
        const { data: analyses } = await supabase
          .from('analysis_history')
          .select('analysis_status')
          .eq('id', analysisId)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (analyses && analyses.length > 0) {
          const analysis = analyses[0];
          const isCanceled = analysis.analysis_status === ANALYSIS_STATUS.CANCELED;
          return {
            isCanceled,
            shouldContinue: !isCanceled,
            reason: isCanceled ? 'User canceled the analysis' : undefined
          };
        }
      }
      
      console.error('Error checking cancellation:', error);
      // If we can't check, assume we should continue (fail-safe)
      return {
        isCanceled: false,
        shouldContinue: true,
        reason: 'Unable to check cancellation status'
      };
    }

    if (!analysis) {
      console.warn('Analysis not found during cancellation check');
      return {
        isCanceled: false,
        shouldContinue: false,
        reason: 'Analysis not found'
      };
    }

    const isCanceled = analysis.analysis_status === ANALYSIS_STATUS.CANCELLED;
    const isErrorStatus = analysis.analysis_status === ANALYSIS_STATUS.ERROR;

    if (isCanceled) {
      console.log(`🛑 Analysis ${analysisId} has been canceled by user`);
      return {
        isCanceled: true,
        shouldContinue: false,
        reason: 'Analysis canceled by user'
      };
    }

    if (isErrorStatus) {
      console.log(`⚠️ Analysis ${analysisId} has error status - checking if retry is in progress`);
      
      // Check if a retry might be in progress by looking at recent update time
      const { data: recentAnalysis, error: recentError } = await supabase
        .from('analysis_history')
        .select('analysis_status, updated_at')
        .eq('id', analysisId)
        .single();
      
      if (!recentError && recentAnalysis) {
        const updatedAt = new Date(recentAnalysis.updated_at);
        const now = new Date();
        const timeDiff = now.getTime() - updatedAt.getTime();
        
        // If updated within last 5 seconds, likely a retry is in progress
        if (timeDiff < 5000) {
          console.log(`🔄 Analysis was recently updated (${timeDiff}ms ago) - likely retry in progress, allowing continuation`);
          return {
            isCanceled: false,
            shouldContinue: true,
            reason: 'Analysis recently updated - retry in progress'
          };
        }
        
        // Re-check status after the second query
        if (recentAnalysis.analysis_status === ANALYSIS_STATUS.RUNNING) {
          console.log(`✅ Analysis status is now RUNNING - retry has updated status`);
          return {
            isCanceled: false,
            shouldContinue: true,
            reason: 'Analysis is running'
          };
        }
      }
      
      console.log(`❌ Analysis ${analysisId} has error status and no recent updates`);
      return {
        isCanceled: false,
        shouldContinue: false,
        reason: 'Analysis has error status'
      };
    }

    console.log(`✅ Analysis ${analysisId} is active, continuing...`);
    return {
      isCanceled: false,
      shouldContinue: true
    };

  } catch (error) {
    console.error('Exception during cancellation check:', error);
    // If there's an exception, assume we should continue (fail-safe)
    return {
      isCanceled: false,
      shouldContinue: true,
      reason: 'Exception during cancellation check'
    };
  }
}

/**
 * Mark an analysis as canceled with proper status updates
 * @param supabase - Supabase client
 * @param analysisId - Analysis ID to cancel
 * @param reason - Reason for cancellation
 */
export async function markAnalysisAsCanceled(
  supabase: any,
  analysisId: string,
  reason: string = 'Canceled during execution'
): Promise<void> {
  try {
    console.log(`🛑 Marking analysis ${analysisId} as canceled: ${reason}`);
    
    // First get current analysis to preserve existing data
    const { data: currentAnalysis } = await supabase
      .from('analysis_history')
      .select('full_analysis')
      .eq('id', analysisId)
      .single();

    const existingMessages = currentAnalysis?.full_analysis?.messages || [];
    
    await supabase
      .from('analysis_history')
      .update({
        analysis_status: ANALYSIS_STATUS.CANCELLED,
        full_analysis: {
          ...currentAnalysis?.full_analysis,
          canceledAt: new Date().toISOString(),
          currentPhase: 'Canceled',
          cancelReason: reason,
          messages: [
            ...existingMessages,
            {
              agent: 'System',
              message: `Analysis canceled: ${reason}`,
              timestamp: new Date().toISOString(),
              type: 'info'
            }
          ]
        }
      })
      .eq('id', analysisId);

    console.log(`✅ Analysis ${analysisId} marked as canceled`);
  } catch (error) {
    console.error('Error marking analysis as canceled:', error);
    throw error;
  }
}