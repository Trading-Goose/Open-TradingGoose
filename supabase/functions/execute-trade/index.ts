import { serve } from "https://deno.land/std@0.210.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { corsHeaders } from '../_shared/cors.ts';
import { verifyAndExtractUser } from '../_shared/auth.ts';
import { TRADE_ORDER_STATUS, isAlpacaOrderTerminal } from '../_shared/statusTypes.ts';
import { 
  createOptionsResponse,
  createMissingParametersResponse,
  createSuccessResponse,
  createErrorResponse,
  createApiErrorResponse
} from '../_shared/responseHelpers.ts';

interface ExecuteTradeRequest {
  tradeActionId: string;   // Direct ID of trading_actions record (primary method)
  action: 'approve' | 'reject';
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify JWT and extract user ID using the same auth pattern as alpaca-proxy
    const authHeader = req.headers.get('Authorization');
    const { userId, error: authError } = await verifyAndExtractUser(authHeader);

    if (authError || !userId) {
      console.error('Authentication failed:', authError);
      return new Response(
        JSON.stringify({ error: authError || 'Authentication failed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    // Use service role to access database
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { tradeActionId, action } = await req.json() as ExecuteTradeRequest;
    
    // Validate that we have tradeActionId
    if (!tradeActionId) {
      return new Response(
        JSON.stringify({ error: 'tradeActionId is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    if (action === 'reject') {
      // Handle rejection - just update status
      const { error: updateError } = await supabaseAdmin
        .from('trading_actions')
        .update({ 
          status: TRADE_ORDER_STATUS.REJECTED
        })
        .eq('id', tradeActionId)
        .eq('user_id', userId);

      if (updateError) throw updateError;

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Trade order rejected',
          status: TRADE_ORDER_STATUS.REJECTED
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle approval - execute on Alpaca
    
    // First get the trade order details
    const { data: tradeOrder, error: fetchError } = await supabaseAdmin
      .from('trading_actions')
      .select('*')
      .eq('id', tradeActionId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !tradeOrder) {
      console.error('Trade order fetch error:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Trade order not found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      );
    }

    // Check if already approved or has Alpaca order
    if (tradeOrder.status === TRADE_ORDER_STATUS.APPROVED && tradeOrder.metadata?.alpaca_order?.id) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: 'Order already executed',
          alpacaOrderId: tradeOrder.metadata?.alpaca_order?.id
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get user's Alpaca credentials
    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('api_settings')
      .select('alpaca_paper_api_key, alpaca_paper_secret_key, alpaca_live_api_key, alpaca_live_secret_key, alpaca_paper_trading')
      .eq('user_id', userId)
      .single();

    if (settingsError || !settings) {
      console.error('Settings error for user', userId, ':', settingsError);
      return new Response(
        JSON.stringify({ error: 'API settings not found. Please configure in Settings.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      );
    }

    // Determine which credentials to use based on paper trading setting
    const isPaper = settings?.alpaca_paper_trading ?? true;
    const alpacaApiKey = isPaper ? settings?.alpaca_paper_api_key : settings?.alpaca_live_api_key;
    const alpacaApiSecret = isPaper ? settings?.alpaca_paper_secret_key : settings?.alpaca_live_secret_key;

    if (!alpacaApiKey || !alpacaApiSecret) {
      console.log('Missing Alpaca credentials for user', userId);
      return new Response(
        JSON.stringify({ error: 'Alpaca credentials not configured. Please add them in Settings.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    // Alpaca API base URL
    const alpacaBaseUrl = isPaper 
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';

    // Prepare order request
    const orderRequest: any = {
      symbol: tradeOrder.ticker,
      side: tradeOrder.action.toLowerCase(),
      type: 'market',
      time_in_force: 'day',
      client_order_id: `ai_${tradeActionId}_${Date.now()}`
    };

    // Set quantity based on order type
    if (tradeOrder.dollar_amount && tradeOrder.dollar_amount > 0) {
      orderRequest.notional = tradeOrder.dollar_amount;
    } else if (tradeOrder.shares && tradeOrder.shares > 0) {
      orderRequest.qty = tradeOrder.shares;
    } else {
      throw new Error('Invalid order: no quantity or dollar amount specified');
    }

    console.log('Submitting Alpaca order:', orderRequest);

    // Submit order to Alpaca
    const alpacaResponse = await fetch(`${alpacaBaseUrl}/v2/orders`, {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID': alpacaApiKey,
        'APCA-API-SECRET-KEY': alpacaApiSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderRequest),
    });

    if (!alpacaResponse.ok) {
      const errorText = await alpacaResponse.text();
      console.error('Alpaca API error:', errorText);
      return new Response(
        JSON.stringify({ error: `Alpaca API error: ${errorText}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: alpacaResponse.status }
      );
    }

    const alpacaOrder = await alpacaResponse.json();
    console.log('Alpaca order created:', alpacaOrder);

    // Update database with Alpaca order info - only update status to approved and add Alpaca metadata
    const { error: updateError } = await supabaseAdmin
      .from('trading_actions')
      .update({
        status: TRADE_ORDER_STATUS.APPROVED,
        executed_at: new Date().toISOString(),
        metadata: {
          ...tradeOrder.metadata,
          alpaca_order: {
            id: alpacaOrder.id,
            client_order_id: alpacaOrder.client_order_id,
            created_at: alpacaOrder.created_at,
            submitted_at: alpacaOrder.submitted_at,
            status: alpacaOrder.status,
            type: alpacaOrder.order_type,
            time_in_force: alpacaOrder.time_in_force,
            limit_price: alpacaOrder.limit_price,
            stop_price: alpacaOrder.stop_price,
            filled_qty: alpacaOrder.filled_qty || null,
            filled_avg_price: alpacaOrder.filled_avg_price || null
          }
        }
      })
      .eq('id', tradeOrder.id)
      .eq('user_id', userId);

    if (updateError) {
      console.error('Failed to update database after order execution:', updateError);
      // Don't throw here - order was successfully placed
    }

    // Start a background task to poll order status
    setTimeout(async () => {
      try {
        await pollOrderStatus(
          alpacaOrder.id,
          tradeOrder.id,
          userId,
          alpacaApiKey,
          alpacaApiSecret,
          alpacaBaseUrl,
          supabaseAdmin
        );
      } catch (err) {
        console.error('Error polling order status:', err);
      }
    }, 5000);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Trade order executed successfully',
        alpacaOrderId: alpacaOrder.id,
        alpacaStatus: alpacaOrder.status,
        order: {
          symbol: alpacaOrder.symbol,
          side: alpacaOrder.side,
          qty: alpacaOrder.qty,
          notional: alpacaOrder.notional,
          type: alpacaOrder.order_type,
          status: alpacaOrder.status
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error executing trade:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Internal server error' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});

// Helper function to poll order status
async function pollOrderStatus(
  alpacaOrderId: string,
  tradeActionId: string,
  userId: string,
  apiKey: string,
  apiSecret: string,
  baseUrl: string,
  supabase: any
) {
  const maxAttempts = 12; // Poll for up to 1 minute
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      // Get order status from Alpaca
      const response = await fetch(`${baseUrl}/v2/orders/${alpacaOrderId}`, {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': apiSecret,
        },
      });

      if (!response.ok) {
        console.error('Failed to fetch order status');
        return;
      }

      const order = await response.json();
      
      // Get current metadata
      const { data: currentAction } = await supabase
        .from('trading_actions')
        .select('metadata')
        .eq('id', tradeActionId)
        .eq('user_id', userId)
        .single();

      // Update database with latest Alpaca status (metadata only - do NOT change main status)
      await supabase
        .from('trading_actions')
        .update({
          metadata: {
            ...currentAction?.metadata,
            alpaca_order: {
              ...currentAction?.metadata?.alpaca_order,
              status: order.status,
              filled_qty: order.filled_qty || null,
              filled_avg_price: order.filled_avg_price || null,
              updated_at: new Date().toISOString()
            }
          }
        })
        .eq('id', tradeActionId)
        .eq('user_id', userId);

      // Stop polling if order is in terminal state
      if (isAlpacaOrderTerminal(order.status)) {
        console.log(`Order ${alpacaOrderId} reached terminal state: ${order.status}`);
        return;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (error) {
      console.error('Error polling order status:', error);
      return;
    }
  }
}