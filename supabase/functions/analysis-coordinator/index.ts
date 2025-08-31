import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleAnalysisRequest } from './handlers/request-handler.ts';
import { corsHeaders } from '../_shared/cors.ts';

/**
 * Analysis Coordinator - Individual Stock Analysis Workflow
 * 
 * This coordinator manages the workflow for individual stock analyses.
 * It handles the full pipeline from initial analysis through risk management
 * and makes the final portfolio management decisions.
 * 
 * Workflow Phases:
 * 1. Analysis: Market, News, Social Media, Fundamentals analysts
 * 2. Research: Bull/Bear researchers with debate rounds
 * 3. Trading: Trading decision agent
 * 4. Risk: Risk analysts and risk manager
 * 5. Decision: Call portfolio manager for final decision
 * 
 * Key Features:
 * - Individual stock analysis workflow management
 * - Phase progression and agent coordination
 * - Cancellation handling
 * - Error recovery and retry logic
 */

/**
 * Main Deno Deploy function handler
 */
serve(async (req: Request): Promise<Response> => {
  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Missing required environment variables');
      return new Response(JSON.stringify({
        error: 'Server configuration error'
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Delegate all request handling to the analysis request handler
    return await handleAnalysisRequest(req, supabase);
    
  } catch (error: any) {
    console.error('❌ Unhandled error in analysis-coordinator:', error);
    
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: error.message
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});