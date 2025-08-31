import { PositionSizingResult } from '../types/interfaces.ts';
import { callAIProviderWithRetry } from '../../_shared/aiProviders.ts';

export function parsePositionSizing(aiResponse: string, context: any): PositionSizingResult {
  // NO REGEX PARSING - rely on extraction agent for accurate values
  // This function now just provides fallback calculations
  
  // Check if AI response contains HOLD
  if (aiResponse.toUpperCase().includes('HOLD')) {
    console.log(`✅ Detected HOLD in fallback parser`);
    return {
      shares: 0,
      dollarAmount: 0,
      percentOfPortfolio: 0,
      entryPrice: context.currentPrice,
      stopLoss: context.currentPrice * 0.95,
      takeProfit: context.currentPrice * 1.10,
      riskRewardRatio: 2.0,
      reasoning: `Hold position`,
      adjustment: 'none'
    };
  }
  
  let dollarAmount = context.defaultPositionSizeDollars;
  let shares = 0;
  let percentOfPortfolio = (dollarAmount / context.totalValue) * 100;
  let reasoning = `Position sized at ${percentOfPortfolio.toFixed(1)}% based on ${context.confidence}% confidence and ${context.userRiskLevel} risk profile`;
  
  // Adjust based on confidence level only (not risk level)
  // These adjustments reflect the strength of the signal, not user preferences
  if (context.confidence >= 80) {
    dollarAmount = dollarAmount * 1.5;
  } else if (context.confidence >= 70) {
    dollarAmount = dollarAmount * 1.2;
  } else if (context.confidence < 60) {
    dollarAmount = dollarAmount * 0.75;
  }
  
  // Risk level should NOT affect position sizing
  // User's default position size already reflects their risk tolerance
  // Only log the risk level for context
  console.log(`📊 User risk level: ${context.userRiskLevel} (position sizing not affected)`)
  
  // Cap at maximum position size
  const maxDollarAmount = (context.maxPositionSize / 100) * context.totalValue;
  dollarAmount = Math.min(dollarAmount, maxDollarAmount);
  
  // IMPORTANT: Cap at available cash (cannot spend more than we have)
  const availableCash = context.availableCash || context.currentCash || 0;
  if (context.decision === 'BUY' && dollarAmount > availableCash) {
    console.log(`⚠️ Position size limited by available cash: $${dollarAmount.toFixed(2)} → $${availableCash.toFixed(2)}`);
    dollarAmount = availableCash;
  }
  
  // Calculate percentage and shares
  percentOfPortfolio = (dollarAmount / context.totalValue) * 100;
  shares = context.currentPrice > 0 ? Math.floor(dollarAmount / context.currentPrice) : 0;
  
  // Default risk management values
  const entryPrice = context.currentPrice;
  const stopLoss = context.currentPrice * 0.95;
  const takeProfit = context.currentPrice * 1.10;
  const riskRewardRatio = 2.0;
  
  return {
    shares,
    dollarAmount,
    percentOfPortfolio,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    reasoning,
    adjustment: 'none'
  };
}

export async function extractPositionSizing(aiResponse: string, context: any, apiSettings?: any): Promise<PositionSizingResult> {
  // Pre-check: If the response clearly contains HOLD, return early with $0
  if (aiResponse.toUpperCase().includes('HOLD')) {
    console.log(`✅ Early HOLD detection - skipping extraction for HOLD decision`);
    return {
      shares: 0,
      dollarAmount: 0,
      percentOfPortfolio: 0,
      entryPrice: context.currentPrice,
      stopLoss: context.currentPrice * 0.95,
      takeProfit: context.currentPrice * 1.10,
      riskRewardRatio: 2.0,
      reasoning: `Hold position - no dollar amount to extract`,
      adjustment: 'none'
    };
  }

  const extractionPrompt = `Extract position details from the portfolio manager's decision.

PORTFOLIO MANAGER'S DECISION:
${aiResponse}

EXTRACTION RULES:
- If the decision contains "HOLD" anywhere → dollarAmount: 0
- Parse format: "BUY $3000 worth TSLA" → dollarAmount: 3000
- Parse format: "SELL $2000 worth NVDA" → dollarAmount: 2000  
- Parse format: "HOLD AAPL" → dollarAmount: 0
- CRITICAL: If you see "HOLD" mentioned for the ticker, set dollarAmount to 0 regardless of other dollar amounts mentioned
- Only extract dollar amounts that are explicitly tied to BUY/SELL actions
- Ignore dollar amounts mentioned for portfolio context, current values, or explanations

OUTPUT JSON FORMAT:
{
  "dollarAmount": number_from_decision,
  "reasoning": "Position based on confidence level"
}

Return ONLY valid JSON.`;

  // Retry logic for extraction - try up to 3 times  
  const maxRetries = 3;
  let extractionResponse = '';
  let parsed: any = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Position sizing extraction attempt ${attempt}/${maxRetries}...`);
      
      // Use 1/4 of portfolio_manager_max_tokens for extraction, with retries increasing
      const baseExtractionTokens = Math.floor((apiSettings?.portfolio_manager_max_tokens || 1200) / 4);
      const attemptTokens = baseExtractionTokens + (attempt - 1) * 200;
      
      // Get more emphatic about completing JSON on retries
      const systemPrompt = attempt === 1 
        ? 'PRIORITY: If you see HOLD anywhere, return {"dollarAmount": 0}. Extract dollar amounts only from explicit "[ACTION] $[amount] worth [TICKER]" format. Return only JSON.'
        : `CRITICAL: Return ONLY JSON.
If text contains "HOLD" → {"dollarAmount": 0, "reasoning": "Hold position"}
Parse "BUY $3000 worth TSLA" → {"dollarAmount": 3000, "reasoning": "Position based on confidence"}
Ignore contextual dollar amounts. Only extract from explicit trade actions.
Finish the ENTIRE JSON structure.`;
      
      extractionResponse = await callAIProviderWithRetry(
        apiSettings || context.apiSettings,
        extractionPrompt,
        systemPrompt,
        attemptTokens,
        3
      );

      console.log(`✅ Position sizing extraction response received (attempt ${attempt}), length: ${extractionResponse.length} chars`);
      console.log(`📝 Raw extraction response: ${extractionResponse.substring(0, 500)}...`);

      // Try to parse the extracted data
      parsed = parsePositionSizingExtraction(extractionResponse, context);
      
      // If parsing succeeded, break out of retry loop
      console.log(`✅ Successfully extracted position sizing on attempt ${attempt}`);
      break;
      
    } catch (parseError) {
      console.error(`❌ Position sizing extraction attempt ${attempt} failed:`, parseError);
      
      if (attempt === maxRetries) {
        // If all attempts failed, fall back to default calculation
        console.log(`⚠️ All extraction attempts failed, using fallback calculation`);
        return parsePositionSizing(aiResponse, context);
      }
      
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  
  if (!parsed) {
    console.log(`⚠️ No parsed result, using fallback calculation`);
    return parsePositionSizing(aiResponse, context);
  }

  return parsed;
}

function parsePositionSizingExtraction(extractionResponse: string, context: any): PositionSizingResult {
  try {
    // Clean up common JSON issues
    let cleanedResponse = extractionResponse
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([\]}])/g, '$1');

    // Extract JSON portion if wrapped in text
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedResponse = jsonMatch[0];
    }

    // Parse the extraction response
    const parsed = JSON.parse(cleanedResponse);
    
    // Check if we have a dollarAmount field (can be 0 for HOLD)
    if (parsed.dollarAmount === undefined || parsed.dollarAmount === null) {
      throw new Error('Missing dollarAmount field');
    }
    
    // For HOLD decisions, dollarAmount should be 0
    if (parsed.dollarAmount === 0) {
      console.log(`✅ Successfully extracted HOLD decision with $0`);
      return {
        shares: 0,
        dollarAmount: 0,
        percentOfPortfolio: 0,
        entryPrice: context.currentPrice,
        stopLoss: context.currentPrice * 0.95,
        takeProfit: context.currentPrice * 1.10,
        riskRewardRatio: 2.0,
        reasoning: parsed.reasoning || `Hold position`,
        adjustment: 'none'
      };
    }
    
    // For non-HOLD decisions, validate amount is positive
    if (parsed.dollarAmount < 0) {
      throw new Error('Invalid negative dollarAmount');
    }
    
    // Validate against portfolio constraints
    if (parsed.dollarAmount > context.totalValue) {
      throw new Error(`Dollar amount ${parsed.dollarAmount} exceeds portfolio value ${context.totalValue}`);
    }
    
    if (context.decision === 'BUY' && parsed.dollarAmount > context.availableCash) {
      console.log(`⚠️ Position size limited by available cash: $${parsed.dollarAmount.toFixed(2)} → $${context.availableCash.toFixed(2)}`);
      parsed.dollarAmount = context.availableCash;
    }
    
    // Calculate derived values
    const shares = context.currentPrice > 0 ? Math.floor(parsed.dollarAmount / context.currentPrice) : 0;
    const percentOfPortfolio = (parsed.dollarAmount / context.totalValue) * 100;
    
    console.log(`✅ Successfully extracted: $${parsed.dollarAmount}, ${shares} shares, ${percentOfPortfolio.toFixed(1)}%`);
    
    return {
      shares,
      dollarAmount: parsed.dollarAmount,
      percentOfPortfolio,
      entryPrice: context.currentPrice,
      stopLoss: context.currentPrice * 0.95,
      takeProfit: context.currentPrice * 1.10,
      riskRewardRatio: 2.0,
      reasoning: parsed.reasoning || `Extracted position: $${parsed.dollarAmount}`,
      adjustment: 'none'
    };
    
  } catch (error) {
    console.error('❌ Failed to parse position sizing extraction:', error);
    console.error('📝 Raw response that failed:', extractionResponse.substring(0, 500));
    
    // Throw error to trigger retry
    throw new Error(`Position sizing extraction failed: ${error.message}`);
  }
}