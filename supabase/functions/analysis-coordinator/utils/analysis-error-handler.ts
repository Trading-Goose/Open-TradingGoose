import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';

/**
 * Unified method to mark an analysis as ERROR
 * This eliminates code duplication and ensures consistent error handling
 */
export async function markAnalysisAsError(
  supabase: any,
  analysisId: string,
  ticker: string,
  userId: string,
  apiSettings: any,
  errorReason: string,
  additionalData?: {
    decision?: string;
    confidence?: number;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`❌ Marking analysis ${analysisId} as ERROR: ${errorReason}`);
    
    // Update the analysis status to ERROR
    const { error: updateError } = await supabase
      .from('analysis_history')
      .update({ 
        analysis_status: ANALYSIS_STATUS.ERROR,
        decision: additionalData?.decision || 'PENDING',  // Use PENDING for failed analyses (no decision was made)
        confidence: additionalData?.confidence || 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', analysisId);
    
    if (updateError) {
      console.error(`❌ Failed to mark analysis as ERROR:`, updateError);
      return { success: false, error: updateError.message };
    }
    
    console.log(`✅ Analysis marked as ERROR successfully`);
    
    
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to mark analysis as ERROR:`, error);
    return { success: false, error: error.message };
  }
}