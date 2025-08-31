# Trading Agent Ecosystem Documentation

## Overview

The TradingGoose system employs a sophisticated multi-agent architecture for comprehensive stock analysis and portfolio management. The system orchestrates multiple AI-powered agents working in phases to deliver thorough investment analysis and trading decisions.

## Agent Architecture

The agent system operates in a **sequential workflow** with five main phases:

1. **Analysis Phase** - Data collection and market analysis
2. **Research Phase** - Debate-driven investment research
3. **Trading Phase** - Strategy formulation
4. **Risk Phase** - Risk assessment and management
5. **Portfolio Phase** - Final portfolio decisions


**Key Workflow Characteristics:**

- **Phase 1**: Analysts run in parallel (no execution order requirement)
- **Phase 2**: Sequential bull-bear debate rounds (user-configurable), concluded by research manager
- **Phase 3**: Single trader agent processes all previous analysis
- **Phase 4**: Risk analysts run in parallel (no execution order requirement), concluded by risk manager
- **Phase 5**: Single portfolio manager makes final decisions

## Workflow Orchestration

### Main Coordinator
- **`analysis-coordinator`** - Central orchestration engine that manages the entire workflow, handles phase transitions, and coordinates agent communication

### Supporting Functions
- **`opportunity-agent`** - Evaluates market opportunities and filters stocks for analysis
- **`execute-trade`** - Handles actual trade execution
- **`process-scheduled-rebalances`** - Manages scheduled portfolio rebalancing

## Core Agents by Phase

### Phase 1: Analysis (Data Collection & Market Analysis)

#### `agent-market-analyst`
- **Purpose**: Technical analysis and market data processing
- **Data Sources**: Yahoo Finance, Alpaca API
- **Capabilities**: 
  - Historical price analysis (up to 1 year)
  - Technical indicators (RSI, MACD, Bollinger Bands, Moving Averages)
  - Volume analysis and market trends
  - Support/resistance level identification
- **Output**: Comprehensive technical analysis with trading signals

#### `agent-news-analyst`
- **Purpose**: News sentiment analysis and event impact assessment
- **Data Sources**: Perplefina API for news aggregation
- **Capabilities**:
  - Recent news analysis with sentiment scoring
  - Press release evaluation
  - Market-moving event identification
  - News impact on stock performance
- **Output**: News sentiment summary with investment implications

#### `agent-social-media-analyst`
- **Purpose**: Social media sentiment and retail investor behavior analysis
- **Data Sources**: Perplefina API for social media data
- **Capabilities**:
  - Twitter/X sentiment analysis
  - Reddit discussion monitoring
  - Influencer opinion tracking
  - Viral trend detection
- **Output**: Social sentiment analysis with crowd behavior insights

#### `agent-fundamentals-analyst`
- **Purpose**: Financial statement analysis and valuation assessment
- **Data Sources**: Perplefina API for financial data
- **Capabilities**:
  - P/E, PEG, EV/EBITDA ratio analysis
  - Cash flow assessment
  - Growth prospects evaluation
  - Sector comparison analysis
- **Output**: Fundamental analysis with BUY/SELL/HOLD recommendation

### Phase 2: Research (Debate-Driven Analysis)

#### `agent-bull-researcher`
- **Purpose**: Builds compelling bullish investment cases
- **Capabilities**:
  - Identifies growth catalysts and opportunities
  - Analyzes competitive advantages
  - Develops upside scenarios and price targets
  - Addresses bear concerns with counter-arguments
- **Output**: Structured bullish thesis with supporting evidence

#### `agent-bear-researcher`
- **Purpose**: Identifies risks and builds bearish cases
- **Capabilities**:
  - Risk factor identification and assessment
  - Downside catalyst analysis
  - Competitive disadvantage evaluation
  - Worst-case scenario modeling
- **Output**: Comprehensive risk assessment with bearish thesis

#### `agent-research-manager`
- **Purpose**: Manages the debate process between bull and bear researchers
- **Capabilities**:
  - Facilitates multi-round debates
  - Ensures thorough argument development
  - Manages research quality and completeness
- **Output**: Moderated research conclusions

### Phase 3: Trading (Strategy Formulation)

#### `agent-trader`
- **Purpose**: Develops trading strategies and execution plans
- **Capabilities**:
  - Synthesizes all previous analysis phases
  - Determines optimal entry/exit points
  - Position sizing recommendations
  - Risk management strategy development
- **Output**: Actionable trading strategy with specific recommendations

### Phase 4: Risk (Risk Assessment & Management)

#### `agent-risky-analyst`
- **Purpose**: Evaluates high-risk investment scenarios
- **Capabilities**:
  - Aggressive growth opportunity assessment
  - High-volatility tolerance strategies
  - Momentum-based risk evaluation
- **Output**: Risk assessment from aggressive investment perspective

#### `agent-safe-analyst`
- **Purpose**: Evaluates conservative investment approaches
- **Capabilities**:
  - Capital preservation strategies
  - Downside risk minimization
  - Conservative growth evaluation
- **Output**: Risk assessment from conservative investment perspective

#### `agent-neutral-analyst`
- **Purpose**: Provides balanced risk assessment
- **Capabilities**:
  - Objective risk evaluation
  - Balanced approach to risk/reward
  - Middle-ground strategy assessment
- **Output**: Balanced risk perspective with moderate recommendations

#### `agent-risk-manager`
- **Purpose**: Final risk assessment and decision synthesis
- **Capabilities**:
  - Integrates all risk analyst perspectives
  - Makes final risk/reward determinations
  - Provides go/no-go investment decisions
  - Sets position sizing and risk limits
- **Output**: Final risk management decision with specific parameters

### Phase 5: Portfolio (Portfolio Management)

#### `analysis-portfolio-manager`
- **Purpose**: Portfolio decisions for individual stock analysis
- **Capabilities**:
  - Individual stock position sizing
  - Portfolio impact assessment
  - Trade order generation for single stocks
  - Risk-adjusted position management
- **Output**: Individual stock trade decisions and orders

#### `rebalance-portfolio-manager`
- **Purpose**: Portfolio rebalancing and allocation optimization
- **Capabilities**:
  - Multi-stock portfolio allocation optimization
  - Rebalancing strategy execution
  - Portfolio-wide risk management
  - Coordinated trade order generation
- **Output**: Portfolio rebalancing plans and coordinated trade orders

## Shared Infrastructure

### Common Utilities (`_shared/`)

- **`aiProviders.ts`** - AI provider abstraction layer supporting multiple LLM providers
- **`alpacaPortfolio.ts`** - Alpaca API integration for portfolio management
- **`atomicUpdate.ts`** - Database update utilities with transaction safety
- **`cancellationCheck.ts`** - Analysis cancellation and cleanup handling
- **`coordinatorNotification.ts`** - Inter-agent communication system
- **`agentSelfInvoke.ts`** - Self-retry and timeout management
- **`marketData.ts`** - Market data fetching and caching utilities
- **`technicalIndicators.ts`** - Technical analysis calculation engine
- **`perplefinaClient.ts`** - Perplefina API client for news/social data
- **`timezoneUtils.ts`** - Market timing and timezone utilities
- **`tradeOrders.ts`** - Trade order processing utilities
- **`types.ts`** - Shared TypeScript type definitions

## Agent Communication Flow

1. **Sequential Execution**: Agents execute in predetermined phases
2. **Data Sharing**: Each agent builds upon previous agents' insights
3. **Atomic Updates**: All database updates use atomic transactions
4. **Error Handling**: Robust error handling with retry mechanisms
5. **Cancellation Support**: Analysis can be cancelled at any point
6. **Progress Tracking**: Real-time progress updates for users

## Key Features

### Multi-Round Debates
The bull and bear researchers engage in multiple debate rounds to thoroughly explore investment theses from both perspectives.

### AI Provider Flexibility
Supports multiple AI providers (OpenAI, Anthropic, etc.) with configurable models and parameters.

### Real-Time Market Data
Integrates with Alpaca and Yahoo Finance for live market data and historical analysis.

### Comprehensive Analysis
Each analysis incorporates technical, fundamental, news, and social sentiment data.

### Risk Management
Multi-perspective risk analysis ensures thorough risk assessment before investment decisions.

### Portfolio Integration
Individual stock analysis integrates seamlessly with portfolio-level decision making.

## Configuration

### Analysis Depth Levels
- **Level 1**: Basic analysis with key insights
- **Level 2**: Standard comprehensive analysis
- **Level 3**: Detailed analysis with extended context
- **Level 4**: Maximum depth analysis with extensive detail

### Optimization Modes
- **Normal**: Standard processing with balanced resource usage
- **Balanced**: Enhanced processing with more data sources

### Market Data Sources
- **Primary**: Alpaca API for reliable real-time data
- **Fallback**: Yahoo Finance for backup data access

## Error Handling & Resilience

- **Automatic Retries**: Agents automatically retry on transient failures
- **Graceful Degradation**: System continues operation even if individual agents fail
- **Comprehensive Logging**: Detailed logging for debugging and monitoring
- **Timeout Management**: Agents have configurable timeouts with self-retry mechanisms
- **Cancellation Support**: Users can cancel long-running analyses

## Security & Access Control

- **API Key Management**: Secure handling of external API credentials
- **User-Specific Data**: All analysis tied to specific user contexts
- **Environment-Based Configuration**: Sensitive data stored in environment variables
- **Supabase Integration**: Leverages Supabase Row Level Security (RLS)

## Performance Optimization

- **Caching**: Market data and technical indicators cached for efficiency
- **Parallel Processing**: Independent agents can process simultaneously
- **Token Management**: Configurable AI token limits for cost control
- **Data Sampling**: Large datasets downsampled for efficient AI processing

---

*This documentation reflects the current state of the TradingGoose agent ecosystem. The system is designed to be modular, scalable, and maintainable while providing comprehensive investment analysis capabilities.*