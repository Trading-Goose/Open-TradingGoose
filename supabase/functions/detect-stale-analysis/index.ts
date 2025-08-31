import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { ANALYSIS_STATUS } from '../_shared/statusTypes.ts';

/**
 * Edge function to detect and reactivate stale running analyses
 * Called by pg_cron periodically to check for analyses stuck in 'running' state
 * Analyses are considered stale if they haven't been updated in 5+ minutes
 * 
 * Note: Only checks RUNNING status, not PENDING (as pending might be queued in rebalance workflows)
 * Restricted to internal calls only (service role authentication required)
 */
serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Restrict access to internal calls only (pg_cron, service role)
    const authHeader = req.headers.get('authorization');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Allow service role (for pg_cron) only
    let supabase;
    if (authHeader?.includes(supabaseServiceKey)) {
      // Service role access (pg_cron)
      supabase = createClient(supabaseUrl, supabaseServiceKey);
    } else {
      // Reject external calls without service role
      return new Response(
        JSON.stringify({ error: 'Unauthorized: This function is for internal use only' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const currentTime = new Date();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes in milliseconds
    const staleTime = new Date(currentTime.getTime() - staleThreshold);

    console.log(`🔍 Detecting stale analyses at ${currentTime.toISOString()}`);
    console.log(`   Looking for analyses not updated since ${staleTime.toISOString()}`);

    // Query for stale RUNNING analyses only
    // We don't check PENDING analyses as they might be queued in a rebalance workflow
    const { data: staleAnalyses, error: fetchError } = await supabase
      .from('analysis_history')
      .select('id, ticker, user_id, updated_at, created_at, analysis_status')
      .eq('analysis_status', ANALYSIS_STATUS.RUNNING)
      .lt('updated_at', staleTime.toISOString())
      .order('updated_at', { ascending: true });

    if (fetchError) {
      throw new Error(`Failed to fetch stale analyses: ${fetchError.message}`);
    }

    if (!staleAnalyses || staleAnalyses.length === 0) {
      console.log('No stale running analyses detected');
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No stale running analyses detected',
          checked_at: currentTime.toISOString(),
          stale_threshold_minutes: 5,
          checked_count: 0,
          reactivated: 0
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${staleAnalyses.length} stale running analysis(es) to reactivate`);

    let reactivatedCount = 0;
    let failedCount = 0;
    const results = [];

    // Process each stale analysis
    for (const analysis of staleAnalyses) {
      try {
        const timeSinceUpdate = currentTime.getTime() - new Date(analysis.updated_at || analysis.created_at).getTime();
        const minutesStale = Math.round(timeSinceUpdate / 60000);

        console.log(`\n🔄 Processing stale analysis ${analysis.id}`);
        console.log(`   Ticker: ${analysis.ticker}`);
        console.log(`   User: ${analysis.user_id}`);
        console.log(`   Status: ${analysis.analysis_status}`);
        console.log(`   Last updated: ${analysis.updated_at} (${minutesStale} minutes ago)`);

        // Get user's API settings for the reactivation
        const { data: apiSettings, error: settingsError } = await supabase
          .from('api_settings')
          .select('*')
          .eq('user_id', analysis.user_id)
          .single();

        if (settingsError || !apiSettings) {
          console.error(`Failed to get API settings for user ${analysis.user_id}:`, settingsError);

          // Mark analysis as error if we can't get settings
          await supabase
            .from('analysis_history')
            .update({
              analysis_status: ANALYSIS_STATUS.ERROR,
              error_message: 'API settings not found during stale detection',
              updated_at: new Date().toISOString()
            })
            .eq('id', analysis.id);

          failedCount++;
          results.push({
            analysisId: analysis.id,
            ticker: analysis.ticker,
            userId: analysis.user_id,
            status: 'error',
            error: 'API settings not found'
          });
          continue;
        }

        console.log('   Invoking analysis-coordinator reactivate action...');

        // Invoke the analysis-coordinator with reactivate action
        const coordinatorResponse = await supabase.functions.invoke(
          'analysis-coordinator',
          {
            body: {
              action: 'reactivate',
              analysisId: analysis.id,
              userId: analysis.user_id,
              forceReactivate: true // Force reactivation since we've already verified it's stale
            }
          }
        );

        if (coordinatorResponse.error) {
          throw new Error(`Coordinator reactivation failed: ${coordinatorResponse.error.message || JSON.stringify(coordinatorResponse.error)}`);
        }

        // Parse response to check if reactivation was successful
        let responseData;
        try {
          responseData = typeof coordinatorResponse.data === 'string'
            ? JSON.parse(coordinatorResponse.data)
            : coordinatorResponse.data;
        } catch (parseError) {
          responseData = coordinatorResponse.data;
        }

        if (responseData?.success === false) {
          throw new Error(responseData.error || 'Reactivation failed');
        }

        reactivatedCount++;
        results.push({
          analysisId: analysis.id,
          ticker: analysis.ticker,
          userId: analysis.user_id,
          status: 'reactivated',
          minutesStale,
          message: responseData?.message || 'Analysis reactivated successfully',
          nextAgent: responseData?.agent,
          phase: responseData?.phase
        });

        console.log(`   ✅ Successfully reactivated analysis ${analysis.id}`);

      } catch (analysisError) {
        console.error(`Error reactivating analysis ${analysis.id}:`, analysisError);

        // Update analysis to error status if reactivation fails
        await supabase
          .from('analysis_history')
          .update({
            analysis_status: ANALYSIS_STATUS.ERROR,
            error_message: `Failed to reactivate stale analysis: ${analysisError.message}`,
            updated_at: new Date().toISOString()
          })
          .eq('id', analysis.id);

        failedCount++;
        results.push({
          analysisId: analysis.id,
          ticker: analysis.ticker,
          userId: analysis.user_id,
          status: 'error',
          error: analysisError.message
        });
      }
    }

    const summary = `Detected ${staleAnalyses.length} stale running analyses: ${reactivatedCount} reactivated, ${failedCount} failed`;
    console.log(`\n📊 Summary: ${summary}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: summary,
        checked_at: currentTime.toISOString(),
        stale_threshold_minutes: 5,
        checked_count: staleAnalyses.length,
        reactivated: reactivatedCount,
        failed: failedCount,
        results
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error) {
    console.error('Error in detect-stale-analysis:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Unknown error occurred',
        checked_at: new Date().toISOString()
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});