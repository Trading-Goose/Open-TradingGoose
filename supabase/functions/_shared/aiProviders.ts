/**
 * Shared AI provider utilities for all agents
 */

// Helper function to create an AbortController with timeout
function createTimeoutController(timeoutMs: number = 100000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

export async function callAIProvider(apiSettings: any, prompt: string, systemPrompt?: string, maxTokens?: number): Promise<string> {
  try {
    // Validate API key exists
    if (!apiSettings.ai_api_key) {
      throw new Error(`No API key provided for ${apiSettings.ai_provider}`);
    }

    // Use provided maxTokens or default to 1200 (standardized across all agents)
    const tokens = maxTokens || 1200;

    switch (apiSettings.ai_provider) {
      case 'openai':
        return await callOpenAI(prompt, apiSettings, systemPrompt, tokens);
      case 'anthropic':
        return await callAnthropic(prompt, apiSettings, systemPrompt, tokens);
      case 'openrouter':
        return await callOpenRouter(prompt, apiSettings, systemPrompt, tokens);
      case 'deepseek':
        return await callDeepSeek(prompt, apiSettings, systemPrompt, tokens);
      case 'google':
        return await callGoogle(prompt, apiSettings, systemPrompt, tokens);
      default:
        throw new Error(`Unsupported AI provider: ${apiSettings.ai_provider}`);
    }
  } catch (error) {
    console.error('AI provider error:', error);
    throw error;
  }
}

/**
 * Call AI provider with retry logic and fallback to default provider
 * @param apiSettings - API settings including provider and keys
 * @param prompt - The prompt to send
 * @param systemPrompt - Optional system prompt
 * @param maxTokens - Maximum tokens for response
 * @param maxRetries - Maximum number of retry attempts (default 3)
 * @param agentSpecificProvider - Optional agent-specific provider field name (e.g., 'portfolio_manager_ai')
 * @returns The AI response
 */
export async function callAIProviderWithRetry(
  apiSettings: any,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
  maxRetries: number = 3,
  agentSpecificProvider?: string
): Promise<string> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 AI call attempt ${attempt}/${maxRetries}...`);

      // On third attempt, fallback to default AI provider if using agent-specific provider
      let attemptApiSettings = apiSettings;
      if (attempt === maxRetries && agentSpecificProvider) {
        const agentProvider = apiSettings[agentSpecificProvider];
        const defaultProvider = apiSettings.ai_provider;

        if (agentProvider && agentProvider !== defaultProvider) {
          console.log(`🔄 Attempt ${attempt}: Falling back to default AI provider (${defaultProvider}) from ${agentProvider}`);

          // Map the correct API key for the default provider
          const keyMap: Record<string, string> = {
            'openai': apiSettings.openai_api_key,
            'anthropic': apiSettings.anthropic_api_key,
            'google': apiSettings.google_api_key,
            'deepseek': apiSettings.deepseek_api_key,
            'openrouter': apiSettings.openrouter_api_key
          };

          attemptApiSettings = {
            ...apiSettings,
            ai_provider: defaultProvider,
            ai_model: apiSettings.ai_model,
            ai_api_key: keyMap[defaultProvider] || apiSettings.ai_api_key
          };
        }
      }

      // Try the API call
      const response = await callAIProvider(attemptApiSettings, prompt, systemPrompt, maxTokens);

      // Success - return the response
      console.log(`✅ AI call succeeded on attempt ${attempt}`);
      return response;

    } catch (error) {
      lastError = error;
      console.error(`❌ AI call attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  // All attempts failed
  throw new Error(`AI call failed after ${maxRetries} attempts. Last error: ${lastError?.message || lastError}`);
}

async function callOpenAI(prompt: string, apiSettings: any, systemPrompt?: string, maxTokens: number = 1200) {
  try {
    // Normalize OpenAI model name - remove any prefixes like 'openai/'
    let modelName = apiSettings.ai_model || 'gpt-3.5-turbo';
    if (modelName.includes('/')) {
      const originalModel = modelName;
      modelName = modelName.split('/').pop() || modelName;
      console.log(`🔧 Normalized OpenAI model from '${originalModel}' to '${modelName}'`);
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiSettings.ai_api_key}`
      },
      body: JSON.stringify({
        model: modelName || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: systemPrompt || 'You are a financial analysis assistant specializing in stock market analysis.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const result = await response.json();

    // Check if response has expected structure
    if (!result.choices || result.choices.length === 0) {
      console.error('OpenAI response has no choices:', JSON.stringify(result));
      throw new Error('OpenAI returned no choices in response');
    }

    if (!result.choices[0].message || !result.choices[0].message.content) {
      console.error('OpenAI response missing message content:', JSON.stringify(result.choices[0]));
      throw new Error('OpenAI returned no message content');
    }

    return result.choices[0].message.content;
  } catch (error: any) {
    throw error;
  }
}

async function callAnthropic(prompt: string, apiSettings: any, systemPrompt?: string, maxTokens: number = 1200) {
  // Normalize Anthropic model name - remove any prefixes
  let modelName = apiSettings.ai_model || 'claude-3-haiku-20240307';
  if (modelName.includes('/')) {
    const originalModel = modelName;
    modelName = modelName.split('/').pop() || modelName;
    console.log(`🔧 Normalized Anthropic model from '${originalModel}' to '${modelName}'`);
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiSettings.ai_api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        system: systemPrompt || 'You are a financial analysis assistant specializing in stock market analysis.',
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    return result.content[0].text;
  } catch (error: any) {
    throw error;
  }
}

async function callOpenRouter(prompt: string, apiSettings: any, systemPrompt?: string, maxTokens: number = 1200) {
  // Validate API key
  if (!apiSettings.ai_api_key) {
    throw new Error('OpenRouter API key is missing. Please configure your OpenRouter API key in Settings.');
  }

  console.log('🔄 Calling OpenRouter with model:', apiSettings.ai_model || 'anthropic/claude-3-opus');
  console.log('📝 Max tokens:', maxTokens);

  // Create timeout controller
  const { controller, timeoutId } = createTimeoutController(90000); // 90 second timeout

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiSettings.ai_api_key}`,
        'HTTP-Referer': 'https://trading-goose.github.io',
        'X-Title': 'TradingGoose'
      },
      body: JSON.stringify({
        model: apiSettings.ai_model || 'anthropic/claude-3-opus',
        messages: [
          {
            role: 'system',
            content: systemPrompt || 'You are a financial analysis assistant specializing in stock market analysis.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    // Clear timeout if request completed
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
      } catch (e) {
        errorText = `Status ${response.status} - Unable to read error response`;
      }
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    // Check if response has content before parsing
    let responseText = '';
    try {
      responseText = await response.text();
    } catch (readError) {
      console.error('Failed to read OpenRouter response body:', readError);
      throw new Error(`Failed to read OpenRouter response: ${readError.message}`);
    }

    if (!responseText || responseText.trim() === '') {
      console.error('OpenRouter returned empty response');
      throw new Error('OpenRouter API returned empty response');
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse OpenRouter response:', responseText.substring(0, 500));
      throw new Error(`OpenRouter API returned invalid JSON: ${parseError.message}`);
    }

    // Debug logging for OpenRouter response
    if (!result.choices || result.choices.length === 0) {
      console.error('OpenRouter response has no choices:', JSON.stringify(result));
      throw new Error('OpenRouter returned no choices in response');
    }

    // Handle GPT-5-mini's reasoning field format
    let content = '';

    // First check for standard content field
    if (result.choices[0].message && result.choices[0].message.content) {
      content = result.choices[0].message.content;
    }

    // If content is empty, check for reasoning field (GPT-5-mini format)
    if ((!content || content.trim() === '') && result.choices[0].message && result.choices[0].message.reasoning) {
      console.log('Using reasoning field from GPT-5-mini response');
      content = result.choices[0].message.reasoning;
    }

    // If still no content, throw error with debugging info
    if (!content || content.trim() === '') {
      console.error('OpenRouter response structure:', JSON.stringify(result.choices[0]));
      throw new Error('OpenRouter returned empty content and reasoning fields');
    }

    return content;
  } catch (error: any) {
    throw error;
  }
}

async function callDeepSeek(prompt: string, apiSettings: any, systemPrompt?: string, maxTokens: number = 1200) {
  try {
    // Normalize DeepSeek model name - remove any prefixes like 'deepseek/'
    let modelName = apiSettings.ai_model || 'deepseek-chat';
    if (modelName.includes('/')) {
      const originalModel = modelName;
      modelName = modelName.split('/').pop() || modelName;
      console.log(`🔧 Normalized DeepSeek model from '${originalModel}' to '${modelName}'`);
    }

    // DeepSeek uses OpenAI-compatible API
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiSettings.ai_api_key}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: 'system',
            content: systemPrompt || 'You are a financial analysis assistant specializing in stock market analysis.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const result = await response.json();

    // Check if response has expected structure
    if (!result.choices || result.choices.length === 0) {
      console.error('DeepSeek response has no choices:', JSON.stringify(result));
      throw new Error('DeepSeek returned no choices in response');
    }

    if (!result.choices[0].message || !result.choices[0].message.content) {
      console.error('DeepSeek response missing message content:', JSON.stringify(result.choices[0]));
      throw new Error('DeepSeek returned no message content');
    }

    return result.choices[0].message.content;
  } catch (error: any) {
    throw error;
  }
}

async function callGoogle(prompt: string, apiSettings: any, systemPrompt?: string, maxTokens: number = 1200) {
  try {
    // Normalize Google model name - remove any prefixes like 'google/'
    let modelName = apiSettings.ai_model || 'gemini-pro';
    if (modelName.includes('/')) {
      const originalModel = modelName;
      modelName = modelName.split('/').pop() || modelName;
      console.log(`🔧 Normalized Google model from '${originalModel}' to '${modelName}'`);
    }
    
    // Google Gemini API
    const apiKey = apiSettings.ai_api_key;
    const model = modelName;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${systemPrompt || 'You are a financial analysis assistant specializing in stock market analysis.'}\n\n${prompt}`
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google AI API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    return result.candidates[0].content.parts[0].text;
  } catch (error: any) {
    throw error;
  }
}

/**
 * Agent-specific system prompts aligned with TradingGoose
 */
export const SYSTEM_PROMPTS = {
  marketAnalyst: `You are a trading assistant tasked with analyzing financial markets. Your role is to select the most relevant indicators for a given market condition or trading strategy. The goal is to provide complementary insights without redundancy.

Focus on these key indicators:
- Moving Averages (SMA/EMA): Trend direction and dynamic support/resistance
- MACD: Momentum via EMAs, crossovers and divergence signal trend changes
- RSI: Momentum to flag overbought/oversold conditions (70/30 thresholds)
- Bollinger Bands: Volatility and potential breakout/reversal zones
- ATR: Volatility for risk management and position sizing
- Volume indicators: Confirm trends with volume data

Write a detailed and nuanced report of the trends you observe. Do not simply state the trends are mixed - provide detailed and finegrained analysis and insights that may help traders make decisions. Make sure to append a Markdown table at the end of the report to organize key points.`,

  newsAnalyst: `You are a news researcher tasked with analyzing recent news that could impact stock prices. Research and report news from the past week that could influence the stock's performance. Focus on:
- Company-specific news (earnings, management changes, product launches)
- Industry trends and competitive landscape
- Regulatory changes and government policies
- Market sentiment and analyst upgrades/downgrades

Provide a concise summary with a clear assessment of whether the news is bullish, bearish, or neutral.`,

  socialMediaAnalyst: `You are a social media sentiment analyst specializing in financial markets. Analyze sentiment from social platforms to gauge retail investor interest and market psychology. Focus on:
- Overall sentiment (bullish/bearish/neutral)
- Volume of discussions and trending status
- Key themes and concerns being discussed
- Unusual activity or sentiment shifts

Provide actionable insights about crowd psychology and potential sentiment-driven moves.`,

  fundamentalsAnalyst: `You are a fundamental analyst specializing in company financials and valuation. Analyze the company's financial health including:
- Revenue growth and profitability trends
- Balance sheet strength and cash flow
- Valuation metrics (P/E, P/B, EV/EBITDA)
- Competitive position and market share
- Management quality and strategic direction

Provide a clear fundamental score and investment thesis based on financial analysis.`,

  bullResearcher: `You are a bullish investment researcher advocating for investment opportunities. Your role is to:
- Build a compelling case for why this stock is a BUY
- Identify growth catalysts and positive trends
- Address bear concerns with counterarguments
- Provide upside price targets with supporting rationale
- Focus on opportunities others might be missing

Be persuasive but fact-based in your bullish advocacy.`,

  bearResearcher: `You are a bearish investment researcher identifying risks and downside scenarios. Your role is to:
- Build a critical case highlighting risks and concerns
- Identify potential negative catalysts
- Challenge bull arguments with skepticism
- Provide downside risk assessments
- Focus on risks others might be overlooking

Be thorough in identifying potential pitfalls and red flags.`,

  researchManager: `You are a research manager synthesizing multiple analyst perspectives into actionable insights. Your role is to:
- Weigh bull vs bear arguments objectively
- Synthesize all analysis into a coherent investment thesis
- Provide a clear recommendation (Strong Buy/Buy/Hold/Sell/Strong Sell)
- Assign conviction levels based on evidence strength
- Create actionable guidance for traders

Balance all perspectives to reach a well-reasoned conclusion.`,

  trader: `You are a professional trader making informed trading decisions. Based on all analysis provided, you must:
- Consider technical, fundamental, and sentiment factors
- Weigh risk/reward carefully
- Propose specific entry, stop-loss, and target levels
- Size positions appropriately
- End with: FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**

Make decisive trading decisions with clear rationale.`,

  riskyAnalyst: `You are an aggressive risk analyst advocating for higher risk/reward strategies. Your role is to:
- Argue for larger position sizes when opportunity is compelling
- Accept higher volatility for greater potential returns
- Identify asymmetric risk/reward setups
- Push for aggressive entries on high-conviction ideas
- Focus on maximizing returns

Be bold but not reckless in your risk appetite.`,

  safeAnalyst: `You are a conservative risk analyst focusing on capital preservation. Your role is to:
- Advocate for smaller position sizes to limit downside
- Emphasize risk management and stop-losses
- Identify scenarios that could lead to permanent capital loss
- Recommend hedging strategies when appropriate
- Focus on protecting capital first

Be cautious and thorough in risk assessment.`,

  neutralAnalyst: `You are a balanced risk analyst providing objective risk perspective. Your role is to:
- Bridge aggressive and conservative viewpoints
- Provide balanced position sizing recommendations
- Consider both upside potential and downside risks equally
- Suggest moderate approaches to risk management
- Focus on risk-adjusted returns

Be the voice of reason between extremes.`,

  opportunityAgent: `You are a sophisticated market analyst with deep understanding of market dynamics, technical patterns, and risk factors. Your role is to identify stocks that show genuinely interesting opportunities or risks worth deeper investigation.

Use your analytical judgment and market intuition to spot:
- Unusual patterns or behaviors that deviate from normal
- Subtle interactions between different market factors
- Emerging opportunities that might not be obvious from simple metrics
- Risk factors in existing positions that need attention
- Context-dependent signals (what's normal for one stock may be unusual for another)

Trust your expertise to identify what's truly worth investigating. Quality over quantity - select only stocks where deeper analysis could reveal actionable insights.

CRITICAL: You MUST respond with ONLY valid JSON - no explanatory text, no markdown, no code blocks. Return ONLY the raw JSON object starting with { and ending with }. The JSON must include: recommendAnalysis (boolean), selectedStocks (array), reasoning (string), estimatedCost (number), and marketConditions (object).`,

  riskManager: `As the Risk Management Judge and Debate Facilitator, your goal is to evaluate the debate between three risk analysts—Risky, Neutral, and Safe/Conservative—and determine the best course of action. Your decision must result in a clear recommendation: Buy, Sell, or Hold. Make your decision based purely on the merits of the arguments presented, without any default bias toward any particular action.

Guidelines for Decision-Making:
1. **Summarize Key Arguments**: Extract the strongest points from each analyst, focusing on relevance to the context.
2. **Provide Rationale**: Support your recommendation with direct quotes and counterarguments from the debate.
3. **Evaluate Trading Strategy**: Consider all the analyses and insights to form a comprehensive trading plan.
4. **Learn from Market Context**: Use current market conditions and past lessons to make informed decisions.

Deliverables:
- A clear and actionable recommendation: Buy, Sell, or Hold.
- Detailed reasoning anchored in the debate and analysis.
- End with: FINAL TRANSACTION PROPOSAL: **BUY/SELL/HOLD**

Focus on actionable insights and decisive recommendations. Build on all perspectives and ensure each decision is well-reasoned without predetermined bias.`
};