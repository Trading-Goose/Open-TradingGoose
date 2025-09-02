<div align="center">

<h1 style="line-height:50px;" align="center"><img src="public/goose.png" alt="TradingGoose Logo" style=" vertical-align: middle; width:35px; height:35px;"> TradingGoose </h1>

[![Discord](https://dcbadge.limes.pink/api/server/3dkTaNyp?style=flat)](https://discord.gg/3dkTaNyp)
 
  
  An intelligent trading platform powered by multiple AI agents that collaborate to analyze markets, manage portfolios, and execute trades with sophisticated risk management.
</div>

<img src="public/screen-shot.png" >

## 📑 Table of Contents

- [📖 Overview](#-overview)
  - [🎯 Core Concept](#-core-concept)
  - [🔄 Intelligent Execution](#-intelligent-execution)
  - [🏗️ Architecture Foundation](#️-architecture-foundation)
- [✨ Features](#-features)
  - [🤖 Multi-Agent Architecture](#-multi-agent-architecture)
  - [📊 Core Capabilities](#-core-capabilities)
  - [🔐 Security & Access Control](#-security--access-control)
- [🛠️ Tech Stack](#️-tech-stack)
  - [🎨 Frontend](#-frontend)
  - [⚙️ Backend](#️-backend)
  - [📈 Trading Integration](#-trading-integration)
- [🔄 How It Works](#-how-it-works)
  - [🔬 The Analysis Process](#-the-analysis-process)
- [🚀 Usage](#-usage)
  - [🔍 Running an Analysis](#-running-an-analysis)
- [🌟 Key Features in Action](#-key-features-in-action)
  - [🧠 Intelligent Analysis](#-intelligent-analysis)
  - [💎 Smart Portfolio Management](#-smart-portfolio-management)
  - [📡 Real-time Monitoring](#-real-time-monitoring)
- [🔒 Security Considerations](#-security-considerations)
- [📄 License](#-license)
- [💬 Support](#-support)
- [🚀 Self Deployment](#-self-deployment)
  - [Prerequisites](#prerequisites)
  - [Perplefina Setup](#perplefina-setup)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
  - [Development Mode](#development-mode)
- [🚧 Development](#-development)
  - [✅ Feature Checklist](#-feature-checklist)
- [🙏 Acknowledgments](#-acknowledgments)

## 📖 Overview

TradingGoose focuses on **event-driven trading strategy and analysis** that harnesses the power of AI agents and Alpaca's market data to deliver sophisticated trading recommendations and automated portfolio management insights. The system employs a multi-agent workflow architecture where specialized AI agents collaborate to analyze market-moving events in real-time.

### 🎯 Core Concept

The system leverages Large Language Models' natural language processing capabilities to rapidly analyze news, social media, and other textual data sources that often trigger market volatility. By processing these events faster than traditional methods, TradingGoose identifies potential market movements and generates timely trading signals for user-selected stocks.

### 🔄 Intelligent Execution

Once analysis agents provide their recommendations, the **Portfolio Manager AI agent** takes over to:
- Analyze the user's Alpaca account details and current portfolio state
- Consider user-configured position sizing, allocation strategies, and risk tolerance
- Generate final trading orders with precise values and actions for specific tickers
- Make autonomous decisions that may differ from initial recommendations based on actual portfolio constraints and risk management

This two-layer approach ensures that while the analysis agents focus on identifying opportunities, the portfolio manager maintains discipline in execution, potentially overriding recommendations when they conflict with portfolio health, risk limits, or allocation rules.

### 🏗️ Architecture Foundation

This project's multi-agent analysis workflow architecture is based on the [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) framework, which pioneered the concept of collaborative AI agents for financial analysis.

## ✨ Features

### 🤖 Multi-Agent Architecture

- **Coordinator Agent**: Orchestrates analysis workflows and manages agent collaboration
- **Market Analyst**: Analyzes market trends and technical indicators
- **Fundamentals Analyst**: Evaluates company financials and valuation metrics
- **News Analyst**: Processes and interprets market news and events
- **Social Media Analyst**: Monitors social sentiment and trending topics
- **Risk Analysts** (Safe/Neutral/Risky): Provides multi-perspective risk assessments
- **Portfolio Manager**: Optimizes portfolio allocation and trade decisions
- **Trader Agent**: Executes trades based on collective intelligence

### 📊 Core Capabilities

- **Real-time Market Analysis**: Continuous monitoring of stocks and market conditions
- **Multi-Stock Analysis**: Analyze multiple stocks simultaneously in a single workflow
- **Portfolio Management**: Comprehensive portfolio optimization with position sizing and allocation strategies
- **Live Trade Execution**: Real order execution through Alpaca Markets (paper and live trading)
- **Risk Assessment**: Multi-dimensional risk analysis from conservative to aggressive perspectives
- **Workflow Visualization**: Real-time tracking of analysis and decision-making processes
- **Historical Tracking**: Complete audit trail of analyses and trades

### 🔐 Security & Access Control

- **Role-Based Access Control (RBAC)**: Granular permission system with admin, moderator, and user roles
- **Secure Authentication**: Supabase-powered authentication with email verification
- **Invitation System**: Controlled user onboarding through admin-managed invitations
- **API Key Management**: Secure storage and management of trading API credentials

## 🛠️ Tech Stack

### 🎨 Frontend

- **React 18** with TypeScript
- **Vite** for fast development and building
- **TailwindCSS** for styling
- **Shadcn/ui** component library
- **React Router** for navigation
- **Recharts** for data visualization

### ⚙️ Backend

- **Supabase** for database, authentication, and real-time updates
- **Edge Functions** for serverless API endpoints & running workflow in background
- **PostgreSQL** for data persistence
- **Row Level Security (RLS)** for data isolation

### 📈 Trading Integration

- **Alpaca Markets API** for market data and trade execution
- **Customizable AI Providers** for agent intelligence (OpenAI, Anthropic, Google, and more)

---

<br >

## 🔄 How It Works

### 🔬 The Analysis Process

When you initiate a stock analysis, TradingGoose orchestrates a sophisticated multi-agent workflow:


<picture style="width:50%">
  <source media="(prefers-color-scheme: dark)" srcset="public/Analysis-Flow-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="public/Analysis-Flow-light.png">
  <img alt="Analysis Flow" src="public/Analysis-Flow-light.png" style=" width:50% height: auto;">
</picture>

###### _Note: This workflow architecture is adapted from the [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) framework._



<details>
<summary><strong>1. 📊 Data Analysis Phase</strong></summary>

- **🌍 Macro Analyst**: Government data and economic indicators
- **📈 Market Analyst**: Historical data and technical indicators
- **📰 News Analyst**: Latest news and sentiment analysis
- **💬 Social Media Analyst**: Social platform trends and impact
- **💰 Fundamentals Analyst**: Financial statements and profitability
</details>

<details>
<summary><strong>2. 🔍 Research & Debate Phase</strong></summary>

- 🐂 Bull Researcher agent presents positive evidence and growth potential
- 🐻 Bear Researcher agent identifies risks and presents cautionary analysis
- ⚖️ Both perspectives are rigorously evaluated for balance
</details>

<details>
<summary><strong>3. ⚠️ Risk Assessment Phase</strong></summary>

- Three specialized risk agents analyze from different perspectives:
  - **🛡️ Safe Agent**: Conservative approach focusing on capital preservation
  - **⚖️ Neutral Agent**: Balanced view weighing opportunities against risks
  - **🚀 Risky Agent**: Aggressive stance for high-growth potential
  </details>

<details>
<summary><strong>4. 🧩 Decision Synthesis</strong></summary>

- 📋 Research Manager consolidates all agent insights
- 🎯 Risk Manager combines analyses with defined risk parameters
- 💼 Portfolio Manager evaluates position sizing and portfolio impact
</details>

<details>
<summary><strong>5. ✅ Execution Ready</strong></summary>

- 📊 Final recommendations are presented with confidence scores
- 🚦 Trade signals are generated based on collective intelligence
- 📝 All analysis is logged for historical tracking
</details>



<br >


---

<br >

## 🚀 Usage

### 🔍 Running an Analysis

1. Navigate to the Dashboard
2. Enter a stock ticker in the search bar
3. Click "Analyze" to trigger the multi-agent workflow
4. Monitor progress in real-time through the workflow visualization
5. Review comprehensive insights from all agents


## 🌟 Key Features in Action

### 🧠 Intelligent Analysis

- **Multi-perspective evaluation**: Every stock is analyzed from bullish and bearish viewpoints
- **Risk-adjusted recommendations**: Three risk profiles ensure suitable strategies for all investors
- **Confidence scoring**: Each recommendation includes transparency about certainty levels
- **Historical context**: Past performance and patterns inform future predictions

### 💎 Smart Portfolio Management

- **Multi-stock portfolio analysis**: Evaluate entire portfolio health and opportunities across all holdings
- **Threshold-based triggers**: Customizable sensitivity to market movements
- **Real order execution**: Direct integration with Alpaca for live market orders
- **Position sizing algorithms**: Smart allocation based on risk, conviction, and portfolio balance
- **Tax-aware decisions**: Considers holding periods and tax implications
- **Dynamic position sizing**: Adjusts positions based on conviction and risk tolerance

### 📡 Real-time Monitoring

- **Live workflow visualization**: Watch agents collaborate in real-time
- **Progress tracking**: See exactly which phase of analysis is active
- **Performance metrics**: Track success rates and portfolio growth
- **Comprehensive audit trail**: Every decision is logged and traceable

## 🔒 Security Considerations

- All API keys are stored encrypted in environment variables
- Database access is controlled through Row Level Security
- User actions are authenticated and authorized through RBAC
- Sensitive operations require admin privileges
- All trades can be executed in paper trading mode for testing

## 📄 License

This project is licensed under the AGPL-3.0 License - see the [LICENSE](LICENSE) file for details.

## 💬 Support

For issues, questions, or suggestions:

- Open an issue on GitHub
- Join our [Discord community](https://discord.gg/3dkTaNyp) for support and discussions! 🎮

## 🚀 Self Deployment

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- A Supabase account (free tier available)
- Perplefina (AI-powered search API) - See setup instructions below

### Perplefina Setup

Perplefina is a required component that provides AI-powered web search capabilities for the trading agents.

1. **Clone and Install Perplefina**
   ```bash
   # Clone the Perplefina repository
   git clone https://github.com/Trading-Goose/Perplefina.git
   cd Perplefina
   
   # Install dependencies
   npm install
   ```

2. **Configure Perplefina**
   - Follow the setup instructions in the [Perplefina repository](https://github.com/Trading-Goose/Perplefina)
   - Configure your AI provider API keys (OpenAI, Anthropic, etc.)
   - Set up your search provider credentials

3. **Deploy Perplefina**
   
   Since Supabase edge functions need to access Perplefina from the internet, you must deploy it publicly:
   
   **Option 1: Deploy to a Cloud Service**
   - Deploy to Railway, Render, Heroku, or any cloud platform
   - Follow the deployment instructions in the Perplefina repository
   - Note your public URL (e.g., `https://your-perplefina.railway.app`)
   
   **Option 2: Use ngrok for Testing**
   ```bash
   # Run Perplefina locally
   npm start
   
   # In another terminal, expose it via ngrok
   ngrok http 3001
   # Note the public URL (e.g., https://abc123.ngrok.io)
   ```

### Backend Setup

1. **Create a Supabase Project**
   - Go to [Supabase](https://supabase.com) and create a new project
   - Note your project URL, anon key, and access token for later use
   - To get your access token:
     - Go to your Supabase project settings
     - Navigate to API settings
     - Find your service role key (this will be used as the access token)

2. **Set up Database Schema**
   - Navigate to the `supabase` directory in this project
   - Copy the contents of `schema.sql`
   - In your Supabase project dashboard, go to the SQL Editor
   - Paste the `schema.sql` content into the editor
   - Run the SQL script to create all necessary functions, tables, and rows

3. **Configure Edge Function Secrets**
   
   **Option A: Via Supabase Web Interface (Recommended)**
   - Go to your [Supabase Dashboard](https://app.supabase.com)
   - Select your project
   - Navigate to **Settings** → **Edge Functions**
   - Click on the **Secrets** tab
   - Click **+ Add new secret**
   - Add the following secret:
     - Name: `PERPLEFINA_API_URL`
     - Value: Your Perplexica API endpoint (must be publicly accessible from the internet)
   - Click **Save**
   
   **Important:** The Perplexica URL must be publicly accessible from the internet. Supabase edge functions cannot access `localhost` or private network addresses. You need to either:
   - Deploy Perplexica to a cloud service (e.g., Railway, Render, Heroku)
   - Use a tunneling service like ngrok for testing (e.g., `https://your-id.ngrok.io`)
   - Host it on a server with a public IP address
   
   **Option B: Via Supabase CLI**
   - If you prefer using the command line:
     ```bash
     # First, install Supabase CLI if you haven't already
     npm install -g supabase
     
     # Login to Supabase
     supabase login
     
     # Link to your project (you'll need your project ref from Supabase dashboard)
     supabase link --project-ref your-project-ref
     
     # Set the Perplexica API URL secret (must be publicly accessible)
     supabase secrets set PERPLEFINA_API_URL=https://your-public-perplexica-url.com
     ```

4. **Deploy Edge Functions**
   - Set up your Supabase access token:
     ```bash
     export SUPABASE_ACCESS_TOKEN=your-access-token-here
     ```
   - Deploy the edge functions:
     ```bash
     cd ./Open-TradingGoose
     bash ./deploy-functions.sh
     ```
   - This will deploy all necessary edge functions for the multi-agent workflow

5. **Configure Environment Variables**
   - Copy `.env.example` to `.env.local`:
     ```bash
     cp .env.example .env.local
     ```
   - Edit `.env.local` and update the Supabase-related variables:
     - `VITE_SUPABASE_URL`: Your Supabase project URL
     - `VITE_SUPABASE_ANON_KEY`: Your Supabase anon key
     - Add any other required API keys as needed

### Frontend Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Build the Project**
   ```bash
   npm run build
   ```

3. **Start the Application**
   ```bash
   npm run start
   ```

### Development Mode

For development with hot reload:
```bash
npm run dev
```

The application will be available at `http://localhost:8080` (or the port shown in your terminal).

## 🚧 Development

🎉 **No humans were harmed in the making of this application!**

This entire project was crafted with love by **[Claude Code](https://claude.ai/code)** - every single line of code, from the sleekest UI component to the smartest trading algorithm, was written by AI. Zero human-written code, 100% AI magic! 🪄

Who says robots can't be creative? This production-ready financial platform proves that AI can build sophisticated applications that actually work in the real world. Welcome to the future of software development! 🚀

---

<br >

### ✅ Feature Checklist

#### Analysis Features

- [x] Multi-stock concurrent analysis
- [x] Cancel/delete running analysis
- [x] Retry failed analysis from specific failed agent
- [x] Reactivate stale/stuck analysis workflows
- [x] Real-time workflow visualization with progress tracking
- [x] Historical analysis tracking and audit trail

#### Portfolio Management

- [x] Position size configuration (min/max)
- [x] Multi-stock portfolio monitoring

#### Trading Features

- [x] Paper trading mode for testing
- [x] Live trading execution via Alpaca
- [x] Real-time order status tracking
- [x] Position management and monitoring

#### AI Configuration

- [x] Multiple AI provider support (OpenAI, Anthropic/Claude, Google, DeepSeek)
- [x] Custom max tokens configuration per agent
- [x] Provider failover and retry logic
- [x] Model selection flexibility

#### Data & Analysis

- [x] Historical data range selection
- [x] Custom analysis timeframes
- [x] Technical indicator calculations
- [x] Fundamental data integration
- [x] News sentiment analysis
- [x] Social media trend tracking

#### User Management

- [x] User Acount system
- [x] API key management interface
- [x] User activity tracking
- [x] Secure credential storage

## 🙏 Acknowledgments

- Built with [Supabase](https://supabase.com)
- Trading powered by [Alpaca Markets](https://alpaca.markets)
- AI analysis powered by customizable providers (OpenAI, Anthropic, Google, and more)
- UI components from [shadcn/ui](https://ui.shadcn.com)
- Multi-agent architecture inspired by [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)
- **100% developed with [Claude Code](https://claude.ai/code)** 🤖

---

**Important**: Always conduct your own research and consider consulting with a financial advisor before making investment decisions. Past performance does not guarantee future results.
