import { CancellationCheckResult } from '../types/index.ts';
import { checkAnalysisCancellation } from '../../_shared/cancellationCheck.ts';
import { ANALYSIS_STATUS } from '../../_shared/statusTypes.ts';

// Re-export the shared cancellation check for analysis
export { checkAnalysisCancellation };

/**
 * Check analysis cancellation status
 * Simply delegates to the shared cancellation check
 */
export async function checkCombinedCancellation(
  supabase: any,
  analysisId: string
): Promise<CancellationCheckResult> {
  return checkAnalysisCancellation(supabase, analysisId);
}