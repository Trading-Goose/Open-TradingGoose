import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Reliably notify the coordinator with retry logic and proper error checking
 * @param supabase - Supabase client instance
 * @param params - Parameters to pass to the coordinator
 * @param agentName - Name of the calling agent for logging
 * @returns Promise that resolves when notification succeeds or all retries fail
 */
export async function notifyCoordinator(
  supabase: SupabaseClient,
  params: {
    analysisId: string;
    ticker: string;
    userId: string;
    phase: string;
    agent: string;
    apiSettings: any;
    analysisContext?: any;
    error?: string; // Optional error to report to coordinator
    errorType?: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'other';
    completionType?: 'normal' | 'last_in_phase' | 'fallback_invocation_failed'; // NEW: Why coordinator is being called
    failedToInvoke?: string; // NEW: Which agent failed to be invoked (for fallback scenarios)
  },
  agentName: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`📡 ${agentName}: Notifying coordinator of completion...`);
  
  const maxRetries = 3;
  let lastError: any = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Determine which coordinator to call based on context
      let coordinatorFunction = 'analysis-coordinator';
      let coordinatorBody: any = params;
      
      // All notifications go to analysis-coordinator
      
      const result = await supabase.functions.invoke(coordinatorFunction, {
        body: coordinatorBody
      });
      
      // Check if the invocation actually succeeded
      if (result.error) {
        throw new Error(`Invocation error: ${result.error.message || JSON.stringify(result.error)}`);
      }
      
      // Check response status
      if (result.data && result.data.success === false) {
        // Some failures are expected (e.g., analysis canceled)
        if (result.data.canceled) {
          console.log(`⚠️ ${agentName}: Analysis was canceled, coordinator acknowledged`);
          return { success: true };
        }
        throw new Error(`Coordinator returned failure: ${result.data.error || result.data.message || 'Unknown error'}`);
      }
      
      console.log(`✅ ${agentName}: Coordinator notified successfully`);
      if (result.data) {
        console.log(`📋 ${agentName}: Coordinator response:`, result.data);
      }
      
      return { success: true };
      
    } catch (error) {
      lastError = error;
      console.error(`❌ ${agentName}: Failed to notify coordinator (attempt ${attempt + 1}/${maxRetries}):`, error);
      
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⏳ ${agentName}: Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries failed
  console.error(`❌ ${agentName}: All retry attempts failed - coordinator may not have been notified!`);
  
  // Store failure in database for manual recovery or monitoring
  try {
    await supabase
      .from('analysis_messages')
      .insert({
        analysis_id: params.analysisId,
        agent_name: params.agent,
        message: `COORDINATOR_NOTIFICATION_FAILED: ${lastError?.message || 'Unknown error'}`,
        message_type: 'error',
        metadata: { 
          error: lastError?.message || 'Unknown error',
          agentName: agentName,
          params: params,
          timestamp: new Date().toISOString() 
        }
      });
  } catch (dbError) {
    console.error(`❌ ${agentName}: Failed to log notification failure to database:`, dbError);
  }
  
  return { 
    success: false, 
    error: lastError?.message || 'Failed to notify coordinator after all retries' 
  };
}

/**
 * Notify coordinator without waiting (fire-and-forget with retry)
 * Use this when you don't want to block on the notification
 */
export function notifyCoordinatorAsync(
  supabase: SupabaseClient,
  params: {
    analysisId: string;
    ticker: string;
    userId: string;
    phase: string;
    agent: string;
    apiSettings: any;
    analysisContext?: any;
    error?: string; // Optional error to report to coordinator
    errorType?: 'rate_limit' | 'api_key' | 'ai_error' | 'data_fetch' | 'other';
    completionType?: 'normal' | 'last_in_phase' | 'fallback_invocation_failed'; // NEW: Why coordinator is being called
    failedToInvoke?: string; // NEW: Which agent failed to be invoked (for fallback scenarios)
  },
  agentName: string
): void {
  notifyCoordinator(supabase, params, agentName)
    .then(result => {
      if (!result.success) {
        console.error(`${agentName}: Background coordinator notification failed:`, result.error);
      }
    })
    .catch(err => {
      console.error(`${agentName}: Background coordinator notification error:`, err);
    });
}