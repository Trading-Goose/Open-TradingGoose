import { serve } from "https://deno.land/std@0.210.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from '../_shared/cors.ts';

interface BatchRequest {
  tickers?: string[];
  includeQuotes?: boolean;
  includeBars?: boolean;
  includeAccount?: boolean;
  includePositions?: boolean;
}
serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Parse the JWT token to get user ID
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({
        error: 'No authorization header'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 401
      });
    }
    const token = authHeader.replace('Bearer ', '');
    // Decode JWT to get user ID
    let userId = null;
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        userId = payload.sub;
      }
    } catch (e) {
      console.error('Failed to decode JWT:', e);
    }
    if (!userId) {
      return new Response(JSON.stringify({
        error: 'Invalid token'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 401
      });
    }
    // Use service role to access database
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // Get user's API settings
    const { data: apiSettings, error: settingsError } = await supabaseAdmin.from('api_settings').select('*').eq('user_id', userId).single();
    if (settingsError || !apiSettings) {
      return new Response(JSON.stringify({
        error: 'API settings not found'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 404
      });
    }
    // Parse request body
    const { 
      tickers = [], 
      includeQuotes = true, 
      includeBars = false,
      includeAccount = false,
      includePositions = false
    }: BatchRequest = await req.json();
    // Validate that we have something to fetch
    if (!includeAccount && !includePositions && (!tickers || tickers.length === 0)) {
      return new Response(JSON.stringify({
        error: 'No tickers provided or account/positions requested'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 400
      });
    }
    
    // Limit to 50 tickers at once
    if (tickers && tickers.length > 50) {
      return new Response(JSON.stringify({
        error: 'Too many tickers. Maximum 50 allowed.'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 400
      });
    }
    // Determine which credentials to use
    const isPaper = apiSettings.alpaca_paper_trading ?? true;
    const apiKey = isPaper ? apiSettings.alpaca_paper_api_key : apiSettings.alpaca_live_api_key;
    const secretKey = isPaper ? apiSettings.alpaca_paper_secret_key : apiSettings.alpaca_live_secret_key;
    if (!apiKey || !secretKey) {
      return new Response(JSON.stringify({
        error: 'Alpaca credentials not configured'
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 400
      });
    }
    const baseUrl = isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
    const dataUrl = 'https://data.alpaca.markets';
    const headers = {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type': 'application/json'
    };
    console.log(`Batch fetching data: ${tickers.length} tickers, account: ${includeAccount}, positions: ${includePositions}`);
    
    const results: Record<string, any> = {};
    
    // Helper function to fetch with timeout and retry
    const fetchWithTimeout = async (url: string, options: any, timeoutMs = 15000, retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          
          const response = await fetch(url, {
            ...options,
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          return response;
        } catch (error: any) {
          if (error.name === 'AbortError') {
            console.error(`Request timeout after ${timeoutMs}ms (attempt ${attempt + 1}/${retries + 1})`);
            if (attempt === retries) {
              throw new Error(`Request timed out after ${retries + 1} attempts`);
            }
            // Wait a bit before retry
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          } else {
            throw error;
          }
        }
      }
      throw new Error('Failed after all retries');
    };
    
    // Fetch account data if requested
    if (includeAccount) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/v2/account`, { headers }, 15000, 1);
        if (response.ok) {
          const accountData = await response.json();
          results.account = accountData;
          console.log('Fetched account data successfully');
        } else {
          const errorText = await response.text();
          console.error('Failed to fetch account:', response.status, errorText);
          // Check for specific Alpaca errors
          if (response.status === 429) {
            return new Response(JSON.stringify({
              error: 'Alpaca rate limit exceeded. Please wait and try again.'
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 429
            });
          } else if (response.status >= 500) {
            return new Response(JSON.stringify({
              error: 'Alpaca services appear to be down. Please check https://app.alpaca.markets/dashboard/overview for status.'
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 503
            });
          }
          // Don't throw - return partial results
        }
      } catch (error: any) {
        console.error('Error fetching account:', error);
        if (error.message?.includes('timed out')) {
          return new Response(JSON.stringify({
            error: 'Unable to connect to Alpaca. Please check if Alpaca services are operational at https://app.alpaca.markets/dashboard/overview'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 504
          });
        }
        // Don't throw - return partial results
      }
    }
    
    // Fetch positions data if requested
    if (includePositions) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/v2/positions`, { headers }, 15000, 1);
        if (response.ok) {
          const positionsData = await response.json();
          results.positions = positionsData;
          console.log(`Fetched ${positionsData.length || 0} positions`);
        } else {
          const errorText = await response.text();
          console.error('Failed to fetch positions:', response.status, errorText);
          if (response.status >= 500) {
            return new Response(JSON.stringify({
              error: 'Alpaca services appear to be down. Please check https://app.alpaca.markets/dashboard/overview for status.'
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 503
            });
          }
          // Don't throw - return partial results
        }
      } catch (error: any) {
        console.error('Error fetching positions:', error);
        if (error.message?.includes('timed out')) {
          return new Response(JSON.stringify({
            error: 'Unable to connect to Alpaca. Please check if Alpaca services are operational at https://app.alpaca.markets/dashboard/overview'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 504
          });
        }
        // Don't throw - return partial results
      }
    }
    
    // Only process ticker data if tickers were provided
    if (tickers && tickers.length > 0) {
      // Fetch all assets in parallel
    const assetPromises = tickers.map(async (ticker) => {
      try {
        const response = await fetch(`${baseUrl}/v2/assets/${ticker}`, {
          headers
        });
        if (response.ok) {
          const data = await response.json();
          return {
            ticker,
            asset: data
          };
        }
        return {
          ticker,
          asset: null
        };
      } catch (error) {
        console.error(`Error fetching asset ${ticker}:`, error);
        return {
          ticker,
          asset: null
        };
      }
    });
    const assetResults = await Promise.all(assetPromises);
    // Store asset results
    for (const { ticker, asset } of assetResults) {
      results[ticker] = {
        asset
      };
    }
    // Fetch quotes if requested
    if (includeQuotes) {
      // Alpaca supports batch quotes with symbols parameter
      const symbolsParam = tickers.join(',');
      try {
        const response = await fetch(`${dataUrl}/v2/stocks/quotes/latest?symbols=${symbolsParam}`, {
          headers
        });
        if (response.ok) {
          const data = await response.json();
          // data.quotes is an object with ticker symbols as keys
          if (data.quotes) {
            for (const ticker of tickers) {
              if (data.quotes[ticker]) {
                results[ticker] = results[ticker] || {};
                results[ticker].quote = data.quotes[ticker];
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching batch quotes:', error);
      }
    }
    // Fetch bars if requested (for previous close)
    // Using snapshot endpoint which provides previous daily bar even for free tier
    if (includeBars) {
      const symbolsParam = tickers.join(',');
      console.log(`Fetching snapshot data for tickers: ${symbolsParam}`);
      try {
        // Snapshot endpoint provides latest trade, quote, minute bar, daily bar, and previous daily bar
        // Free tier users can access the previous daily bar
        const snapshotUrl = `${dataUrl}/v2/stocks/snapshots?symbols=${symbolsParam}`;
        console.log(`Snapshot URL: ${snapshotUrl}`);
        const response = await fetch(snapshotUrl, {
          headers
        });
        if (response.ok) {
          const data = await response.json();
          console.log(`Snapshot response received for: ${Object.keys(data || {}).join(', ')}`);
          // The response structure is { ticker: { latestTrade, latestQuote, minuteBar, dailyBar, prevDailyBar } }
          for (const ticker of tickers) {
            if (data[ticker]) {
              results[ticker] = results[ticker] || {};
              // Get previous daily bar for calculating change
              if (data[ticker].prevDailyBar) {
                results[ticker].previousBar = data[ticker].prevDailyBar;
                console.log(`${ticker}: Got previous daily bar, close: ${data[ticker].prevDailyBar.c}`);
              }
              // Also get current daily bar if available
              if (data[ticker].dailyBar) {
                results[ticker].currentBar = data[ticker].dailyBar;
                console.log(`${ticker}: Got current daily bar, close: ${data[ticker].dailyBar.c}`);
              }
            } else {
              console.log(`${ticker}: No snapshot data received`);
            }
          }
        } else {
          const errorText = await response.text();
          console.error(`Snapshot request failed with status ${response.status}: ${errorText}`);
          // Fallback to bars endpoint with IEX feed for free tier
          console.log('Falling back to bars endpoint with IEX feed');
          const endDate = new Date();
          endDate.setDate(endDate.getDate() - 1);
          const startDate = new Date(endDate);
          startDate.setDate(startDate.getDate() - 10);
          const startStr = startDate.toISOString().split('T')[0];
          const endStr = endDate.toISOString().split('T')[0];
          const barsUrl = `${dataUrl}/v2/stocks/bars?symbols=${symbolsParam}&timeframe=1Day&start=${startStr}&end=${endStr}&limit=5&adjustment=raw&feed=iex`;
          const barsResponse = await fetch(barsUrl, {
            headers
          });
          if (barsResponse.ok) {
            const barsData = await barsResponse.json();
            if (barsData.bars) {
              for (const ticker of tickers) {
                if (barsData.bars[ticker] && barsData.bars[ticker].length > 0) {
                  results[ticker] = results[ticker] || {};
                  const bars = barsData.bars[ticker];
                  const mostRecentBar = bars[bars.length - 1];
                  results[ticker].previousBar = mostRecentBar;
                  console.log(`${ticker}: Got ${bars.length} bars from IEX fallback, using most recent close: ${mostRecentBar.c}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching snapshot data:', error);
      }
    }
    } // Close the tickers processing block
    
    return new Response(JSON.stringify({
      data: results
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Alpaca batch error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error'
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
