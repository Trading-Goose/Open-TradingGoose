

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "cron";

COMMENT ON SCHEMA "public" IS 'TradingGoose public schema - Core trading and analysis functionality';

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "wrappers" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "public"."check_analysis_exists"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only check for individual_analysis source type
  IF NEW.source_type = 'individual_analysis' AND NEW.analysis_id IS NOT NULL THEN
    -- Verify the analysis exists
    IF NOT EXISTS (
      SELECT 1 FROM public.analysis_history 
      WHERE id = NEW.analysis_id
    ) THEN
      RAISE EXCEPTION 'Analysis with ID % does not exist', NEW.analysis_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."check_analysis_exists"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_ny_current_date"() RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT (NOW() AT TIME ZONE 'America/New_York')::DATE;
$$;

ALTER FUNCTION "public"."get_ny_current_date"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."sync_user_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- This function runs AFTER user creation, so it can't block it
    -- We use a separate transaction context to avoid conflicts
    
    -- Create or update profile
    INSERT INTO public.profiles (id, email, name, created_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data->>'name',
            NEW.raw_user_meta_data->>'full_name',
            split_part(NEW.email, '@', 1)
        ),
        NEW.created_at
    )
    ON CONFLICT (id) 
    DO UPDATE SET 
        email = EXCLUDED.email,
        updated_at = NOW()
    WHERE profiles.id = EXCLUDED.id;
    
    -- Handle roles asynchronously to avoid blocking
    PERFORM pg_notify(
        'new_user_created',
        json_build_object(
            'user_id', NEW.id,
            'email', NEW.email
        )::text
    );
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- Never fail - just log the error
        RAISE WARNING 'Profile sync error for user %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."sync_user_profile"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_debate_round"("p_analysis_id" "uuid", "p_round" integer, "p_agent_type" "text", "p_response" "text", "p_points" "text"[]) RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    current_analysis JSONB;
    debate_rounds JSONB;
    round_data JSONB;
    messages JSONB;
BEGIN
    -- Get current full_analysis
    SELECT full_analysis INTO current_analysis 
    FROM analysis_history 
    WHERE id = p_analysis_id;
    
    IF current_analysis IS NULL THEN
        current_analysis := '{}'::JSONB;
    END IF;
    
    -- Get current debate rounds
    debate_rounds := COALESCE(current_analysis->'debateRounds', '[]'::JSONB);
    
    -- Get current messages
    messages := COALESCE(current_analysis->'messages', '[]'::JSONB);
    
    -- Add message
    messages := messages || jsonb_build_array(
        jsonb_build_object(
            'agent', p_agent_type || ' Researcher',
            'message', p_response,
            'timestamp', NOW()::TEXT,
            'type', 'research',
            'round', p_round
        )
    );
    
    -- Ensure we have enough rounds in the array
    WHILE jsonb_array_length(debate_rounds) < p_round LOOP
        debate_rounds := debate_rounds || jsonb_build_array(
            jsonb_build_object(
                'round', jsonb_array_length(debate_rounds) + 1,
                'timestamp', NOW()::TEXT
            )
        );
    END LOOP;
    
    -- Get the specific round (0-indexed)
    round_data := debate_rounds->((p_round - 1)::INT);
    
    -- Merge the new data with existing round data
    IF p_agent_type = 'bull' THEN
        round_data := round_data || jsonb_build_object(
            'bull', p_response,
            'bullPoints', to_jsonb(p_points)
        );
    ELSIF p_agent_type = 'bear' THEN
        round_data := round_data || jsonb_build_object(
            'bear', p_response,
            'bearPoints', to_jsonb(p_points)
        );
    END IF;
    
    -- Update the round in the array
    debate_rounds := jsonb_set(
        debate_rounds,
        ARRAY[(p_round - 1)::TEXT],
        round_data
    );
    
    -- Update the analysis
    UPDATE analysis_history 
    SET full_analysis = current_analysis || jsonb_build_object(
        'debateRounds', debate_rounds,
        'messages', messages,
        'lastUpdated', NOW()::TEXT
    )
    WHERE id = p_analysis_id;
    
    RETURN FOUND;
END;
$$;

ALTER FUNCTION "public"."update_debate_round"("p_analysis_id" "uuid", "p_round" integer, "p_agent_type" "text", "p_response" "text", "p_points" "text"[]) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_workflow_step_status"("p_analysis_id" "uuid", "p_phase_id" "text", "p_agent_name" "text", "p_status" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    current_analysis JSONB;
    workflow_steps JSONB;
    step_data JSONB;
    agents JSONB;
    agent_data JSONB;
    step_index INT;
    agent_index INT;
BEGIN
    -- Get current full_analysis
    SELECT full_analysis INTO current_analysis 
    FROM analysis_history 
    WHERE id = p_analysis_id;
    
    IF current_analysis IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Get workflow steps
    workflow_steps := COALESCE(current_analysis->'workflowSteps', '[]'::JSONB);
    
    -- Find the step index
    SELECT idx - 1 INTO step_index
    FROM (
        SELECT ROW_NUMBER() OVER () as idx, value
        FROM jsonb_array_elements(workflow_steps)
    ) AS steps
    WHERE value->>'id' = p_phase_id;
    
    IF step_index IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Get the step data
    step_data := workflow_steps->step_index;
    agents := step_data->'agents';
    
    -- Find the agent index
    SELECT idx - 1 INTO agent_index
    FROM (
        SELECT ROW_NUMBER() OVER () as idx, value
        FROM jsonb_array_elements(agents)
    ) AS agent_list
    WHERE value->>'name' = p_agent_name;
    
    IF agent_index IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Get current agent data
    agent_data := agents->agent_index;
    
    -- Update agent status
    agent_data := agent_data || jsonb_build_object(
        'status', p_status,
        'progress', CASE WHEN p_status = 'completed' THEN 100 ELSE 50 END
    );
    
    -- Add completion timestamp if completed
    IF p_status = 'completed' THEN
        agent_data := agent_data || jsonb_build_object(
            'completedAt', NOW()::TEXT
        );
    END IF;
    
    -- Update the agent in the agents array
    agents := jsonb_set(
        agents,
        ARRAY[agent_index::TEXT],
        agent_data
    );
    
    -- Update the step with new agents array
    step_data := step_data || jsonb_build_object('agents', agents);
    
    -- Update the step in workflow_steps
    workflow_steps := jsonb_set(
        workflow_steps,
        ARRAY[step_index::TEXT],
        step_data
    );
    
    -- Update the analysis
    UPDATE analysis_history 
    SET full_analysis = current_analysis || jsonb_build_object(
        'workflowSteps', workflow_steps,
        'lastUpdated', NOW()::TEXT
    )
    WHERE id = p_analysis_id;
    
    RETURN FOUND;
END;
$$;

ALTER FUNCTION "public"."update_workflow_step_status"("p_analysis_id" "uuid", "p_phase_id" "text", "p_agent_name" "text", "p_status" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."validate_trade_order"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Ensure either shares or dollar_amount is set, but not both
    IF NEW.action IN ('BUY', 'SELL') THEN
        IF (NEW.shares = 0 OR NEW.shares IS NULL) AND 
           (NEW.dollar_amount = 0 OR NEW.dollar_amount IS NULL) THEN
            RAISE EXCEPTION 'Trade order must specify either shares or dollar amount';
        END IF;
        
        IF NEW.shares > 0 AND NEW.dollar_amount > 0 THEN
            RAISE EXCEPTION 'Trade order cannot specify both shares and dollar amount';
        END IF;
    END IF;
    
    -- Validate metadata structure if provided
    IF NEW.metadata IS NOT NULL AND NEW.metadata != '{}'::jsonb THEN
        IF NOT (NEW.metadata ? 'beforePosition' AND 
                NEW.metadata ? 'afterPosition' AND 
                NEW.metadata ? 'changes') THEN
            RAISE EXCEPTION 'Invalid metadata structure - must include beforePosition, afterPosition, and changes';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."validate_trade_order"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."analysis_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "analysis_date" "date" NOT NULL,
    "decision" "text" NOT NULL,
    "confidence" numeric(5,2) NOT NULL,
    "agent_insights" "jsonb",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "full_analysis" "jsonb",
    "is_canceled" boolean DEFAULT false,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "analysis_context" "jsonb",
    "analysis_status" "text" DEFAULT 'pending'::"text",
    CONSTRAINT "analysis_history_confidence_check" CHECK ((("confidence" >= (0)::numeric) AND ("confidence" <= (100)::numeric))),
    CONSTRAINT "analysis_history_decision_check" CHECK (("decision" = ANY (ARRAY['BUY'::"text", 'SELL'::"text", 'HOLD'::"text", 'PENDING'::"text"]))),
    CONSTRAINT "analysis_history_status_check" CHECK (("analysis_status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'error'::"text", 'cancelled'::"text"])))
);

ALTER TABLE "public"."analysis_history" OWNER TO "postgres";

COMMENT ON COLUMN "public"."analysis_history"."is_canceled" IS 'TRUE if analysis was manually canceled by user';

COMMENT ON COLUMN "public"."analysis_history"."analysis_status" IS 'Analysis status: pending, running, completed, error, cancelled';

CREATE TABLE IF NOT EXISTS "public"."analysis_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "agent_name" "text" NOT NULL,
    "message" "text" NOT NULL,
    "message_type" "text" DEFAULT 'analysis'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "processed" boolean DEFAULT false,
    "metadata" "jsonb"
);

ALTER TABLE "public"."analysis_messages" OWNER TO "postgres";

COMMENT ON COLUMN "public"."analysis_messages"."metadata" IS 'Additional metadata for the message (e.g., debate round number)';

CREATE TABLE IF NOT EXISTS "public"."api_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ai_provider" "text" NOT NULL,
    "ai_api_key" "text",
    "ai_model" "text",
    "polygon_api_key" "text",
    "alpaca_paper_api_key" "text",
    "alpaca_paper_secret_key" "text",
    "alpaca_live_api_key" "text",
    "alpaca_live_secret_key" "text",
    "alpaca_paper_trading" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "openai_api_key" "text",
    "anthropic_api_key" "text",
    "google_api_key" "text",
    "deepseek_api_key" "text",
    "openrouter_api_key" "text",
    "analysis_team_model" "text",
    "research_team_model" "text",
    "trading_team_model" "text",
    "risk_team_model" "text",
    "default_provider_id" "uuid",
    "analysis_team_provider_id" "uuid",
    "research_team_provider_id" "uuid",
    "trading_team_provider_id" "uuid",
    "risk_team_provider_id" "uuid",
    "research_debate_rounds" integer DEFAULT 2,
    "analysis_team_ai" "text",
    "research_team_ai" "text",
    "trading_team_ai" "text",
    "risk_team_ai" "text",
    "analysis_max_tokens" integer DEFAULT 1200,
    "research_max_tokens" integer DEFAULT 1200,
    "trading_max_tokens" integer DEFAULT 1200,
    "risk_max_tokens" integer DEFAULT 1200,
    "opportunity_market_range" "text" DEFAULT '1M'::"text",
    "target_stock_allocation" numeric DEFAULT 80,
    "target_cash_allocation" numeric DEFAULT 20,
    "default_max_position_size" numeric DEFAULT 25,
    "default_min_position_size" numeric DEFAULT 2,
    "opportunity_agent_ai" "text",
    "opportunity_agent_model" "text",
    "opportunity_max_tokens" integer DEFAULT 1200,
    "auto_execute_trades" boolean DEFAULT false,
    "default_position_size_dollars" numeric DEFAULT 1000,
    "user_risk_level" "text" DEFAULT 'moderate'::"text",
    "portfolio_manager_ai" "text",
    "portfolio_manager_model" "text",
    "portfolio_manager_max_tokens" integer DEFAULT 1200,
    "opportunity_agent_provider_id" "uuid",
    "analysis_history_days" "text" DEFAULT '1M'::"text",
    "analysis_optimization" character varying(20) DEFAULT 'speed'::character varying,
    "portfolio_manager_provider_id" "uuid",
    CONSTRAINT "api_settings_ai_provider_check" CHECK (("ai_provider" = ANY (ARRAY['openai'::"text", 'anthropic'::"text", 'google'::"text", 'openrouter'::"text", 'deepseek'::"text"]))),
    CONSTRAINT "api_settings_analysis_history_days_check" CHECK (("analysis_history_days" = ANY (ARRAY['1M'::"text", '3M'::"text", '6M'::"text", '1Y'::"text"]))),
    CONSTRAINT "api_settings_analysis_max_tokens_check" CHECK ((("analysis_max_tokens" >= 500) AND ("analysis_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_analysis_optimization_check" CHECK (((("analysis_optimization")::"text" = ANY ((ARRAY['speed'::character varying, 'balanced'::character varying])::"text"[])) OR ("analysis_optimization" IS NULL))),
    CONSTRAINT "api_settings_opportunity_market_range_check" CHECK (("opportunity_market_range" = ANY (ARRAY['1D'::"text", '1W'::"text", '1M'::"text", '3M'::"text", '1Y'::"text"]))),
    CONSTRAINT "api_settings_opportunity_max_tokens_check" CHECK ((("opportunity_max_tokens" >= 500) AND ("opportunity_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_portfolio_manager_max_tokens_check" CHECK ((("portfolio_manager_max_tokens" >= 500) AND ("portfolio_manager_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_research_debate_rounds_check" CHECK ((("research_debate_rounds" >= 1) AND ("research_debate_rounds" <= 10))),
    CONSTRAINT "api_settings_research_max_tokens_check" CHECK ((("research_max_tokens" >= 500) AND ("research_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_risk_max_tokens_check" CHECK ((("risk_max_tokens" >= 500) AND ("risk_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_target_cash_allocation_check" CHECK ((("target_cash_allocation" >= (0)::numeric) AND ("target_cash_allocation" <= (100)::numeric))),
    CONSTRAINT "api_settings_target_stock_allocation_check" CHECK ((("target_stock_allocation" >= (0)::numeric) AND ("target_stock_allocation" <= (100)::numeric))),
    CONSTRAINT "api_settings_default_max_position_size_check" CHECK ((("default_max_position_size" >= (0)::numeric) AND ("default_max_position_size" <= (100)::numeric))),
    CONSTRAINT "api_settings_default_min_position_size_check" CHECK ((("default_min_position_size" >= (0)::numeric) AND ("default_min_position_size" <= (100)::numeric))),
    CONSTRAINT "api_settings_position_size_order_check" CHECK (("default_min_position_size" <= "default_max_position_size")),
    CONSTRAINT "api_settings_trading_max_tokens_check" CHECK ((("trading_max_tokens" >= 500) AND ("trading_max_tokens" <= 8000))),
    CONSTRAINT "api_settings_user_risk_level_check" CHECK (("user_risk_level" = ANY (ARRAY['conservative'::"text", 'moderate'::"text", 'aggressive'::"text"]))),
    CONSTRAINT "check_allocation_total" CHECK ((("target_stock_allocation" + "target_cash_allocation") = (100)::numeric))
);

ALTER TABLE "public"."api_settings" OWNER TO "postgres";

COMMENT ON TABLE "public"."api_settings" IS 'User API settings with RLS enabled for data isolation';

COMMENT ON COLUMN "public"."api_settings"."openai_api_key" IS 'OpenAI API key for GPT models';

COMMENT ON COLUMN "public"."api_settings"."anthropic_api_key" IS 'Anthropic API key for Claude models';

COMMENT ON COLUMN "public"."api_settings"."google_api_key" IS 'Google API key for Gemini models';

COMMENT ON COLUMN "public"."api_settings"."deepseek_api_key" IS 'DeepSeek API key';

COMMENT ON COLUMN "public"."api_settings"."openrouter_api_key" IS 'OpenRouter API key for multiple models';

COMMENT ON COLUMN "public"."api_settings"."analysis_team_model" IS 'Specific model for analysis team agents';

COMMENT ON COLUMN "public"."api_settings"."research_team_model" IS 'Specific model for research team agents';

COMMENT ON COLUMN "public"."api_settings"."trading_team_model" IS 'Specific model for trading decision agent';

COMMENT ON COLUMN "public"."api_settings"."risk_team_model" IS 'Specific model for risk management agents';

COMMENT ON COLUMN "public"."api_settings"."research_debate_rounds" IS 'Number of debate rounds for research team (bull vs bear)';

COMMENT ON COLUMN "public"."api_settings"."analysis_team_ai" IS 'AI provider for analysis team agents';

COMMENT ON COLUMN "public"."api_settings"."research_team_ai" IS 'AI provider for research team agents';

COMMENT ON COLUMN "public"."api_settings"."trading_team_ai" IS 'AI provider for trading decision agent';

COMMENT ON COLUMN "public"."api_settings"."risk_team_ai" IS 'AI provider for risk management agents';

COMMENT ON COLUMN "public"."api_settings"."analysis_max_tokens" IS 'Maximum response tokens for analysis agents (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."research_max_tokens" IS 'Maximum response tokens for research agents during debate (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."trading_max_tokens" IS 'Maximum response tokens for trading decision agent (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."risk_max_tokens" IS 'Maximum response tokens for risk management agents (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."opportunity_market_range" IS 'Time range for historical market data in opportunity agent: 1D (1 day), 1W (1 week), 1M (1 month), 3M (3 months), 1Y (1 year)';

COMMENT ON COLUMN "public"."api_settings"."target_stock_allocation" IS 'Target percentage of portfolio to allocate to stocks (0-100)';

COMMENT ON COLUMN "public"."api_settings"."target_cash_allocation" IS 'Target percentage of portfolio to maintain as cash (0-100)';

COMMENT ON COLUMN "public"."api_settings"."default_max_position_size" IS 'Maximum position size as percentage of portfolio (0-100). Default: 25%';

COMMENT ON COLUMN "public"."api_settings"."default_min_position_size" IS 'Minimum position size as percentage of portfolio (0-100). Default: 2%';

COMMENT ON COLUMN "public"."api_settings"."opportunity_agent_ai" IS 'AI provider for opportunity agent';

COMMENT ON COLUMN "public"."api_settings"."opportunity_agent_model" IS 'Model to use for opportunity agent';

COMMENT ON COLUMN "public"."api_settings"."opportunity_max_tokens" IS 'Maximum response tokens for opportunity agent (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."auto_execute_trades" IS 'When true, approved trade orders are automatically executed without manual confirmation';

COMMENT ON COLUMN "public"."api_settings"."default_position_size_dollars" IS 'Default position size in dollars when using dollar-based orders';

COMMENT ON COLUMN "public"."api_settings"."user_risk_level" IS 'User risk tolerance level: conservative, moderate, or aggressive';

COMMENT ON COLUMN "public"."api_settings"."portfolio_manager_ai" IS 'AI provider for portfolio manager agent (anthropic, openai, etc)';

COMMENT ON COLUMN "public"."api_settings"."portfolio_manager_model" IS 'Model to use for portfolio manager agent';

COMMENT ON COLUMN "public"."api_settings"."portfolio_manager_max_tokens" IS 'Maximum response tokens for portfolio manager agent (default: 1200, range: 500-8000)';

COMMENT ON COLUMN "public"."api_settings"."opportunity_agent_provider_id" IS 'Provider configuration ID for opportunity agent';

COMMENT ON COLUMN "public"."api_settings"."analysis_history_days" IS 'Historical data range for analysis agents (1M, 3M, 6M, 1Y)';

COMMENT ON COLUMN "public"."api_settings"."analysis_optimization" IS 'Optimization strategy for analysis. Values: speed (faster, less thorough) or balanced (slower, more thorough). Default: speed';

COMMENT ON COLUMN "public"."api_settings"."portfolio_manager_provider_id" IS 'Reference to provider_configurations for portfolio manager agent-specific AI provider';

CREATE OR REPLACE VIEW "public"."api_settings_unified" WITH ("security_invoker"='true') AS
 SELECT "user_id",
    "ai_provider",
    "ai_api_key",
    "ai_model",
    "analysis_optimization" AS "news_social_optimization",
    "analysis_history_days",
    "research_debate_rounds",
    "analysis_max_tokens",
    "research_max_tokens",
    "trading_max_tokens",
    "risk_max_tokens",
    "created_at",
    "updated_at"
   FROM "public"."api_settings";

ALTER VIEW "public"."api_settings_unified" OWNER TO "postgres";

COMMENT ON VIEW "public"."api_settings_unified" IS 'Unified API settings view. Uses SECURITY INVOKER to respect user permissions and RLS policies.';

CREATE TABLE IF NOT EXISTS "public"."market_data_cache" (
    "ticker" "text" NOT NULL,
    "timeframe" "text" DEFAULT '1Y'::"text" NOT NULL,
    "historical_data" "jsonb" NOT NULL,
    "technical_indicators" "jsonb" NOT NULL,
    "data_points" integer NOT NULL,
    "analysis_range" "text" NOT NULL,
    "fetched_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."market_data_cache" OWNER TO "postgres";

COMMENT ON TABLE "public"."market_data_cache" IS 'Market data cache using New York timezone (America/New_York) for all date operations';

COMMENT ON COLUMN "public"."market_data_cache"."fetched_date" IS 'Date when data was fetched, in New York timezone (YYYY-MM-DD format)';

COMMENT ON COLUMN "public"."market_data_cache"."created_at" IS 'Timestamp when cache entry was created, stored in UTC but represents NY time operation';

COMMENT ON COLUMN "public"."market_data_cache"."updated_at" IS 'Timestamp when cache entry was last updated, stored in UTC but represents NY time operation';

CREATE OR REPLACE VIEW "public"."market_cache_status" WITH ("security_invoker"='true') AS
 SELECT "ticker",
    "timeframe",
    "fetched_date",
    "data_points",
    "created_at",
    "updated_at"
   FROM "public"."market_data_cache"
  ORDER BY "created_at" DESC;

ALTER VIEW "public"."market_cache_status" OWNER TO "postgres";

COMMENT ON VIEW "public"."market_cache_status" IS 'Market data cache status view. Converted to SECURITY INVOKER to respect user permissions and RLS policies.';

CREATE TABLE IF NOT EXISTS "public"."portfolios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "total_value" numeric(15,2) DEFAULT 0,
    "cash_available" numeric(15,2) DEFAULT 100000,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."portfolios" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "portfolio_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "shares" numeric(15,4) NOT NULL,
    "avg_cost" numeric(10,2) NOT NULL,
    "current_price" numeric(10,2),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."positions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "name" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "full_name" "text"
);

ALTER TABLE "public"."profiles" OWNER TO "postgres";

COMMENT ON TABLE "public"."profiles" IS 'User profiles with RLS enabled for data isolation';

CREATE TABLE IF NOT EXISTS "public"."provider_configurations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "nickname" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "api_key" "text" NOT NULL,
    "is_default" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_configurations_provider_check" CHECK (("provider" = ANY (ARRAY['openai'::"text", 'anthropic'::"text", 'google'::"text", 'deepseek'::"text", 'openrouter'::"text"])))
);

ALTER TABLE "public"."provider_configurations" OWNER TO "postgres";

COMMENT ON TABLE "public"."provider_configurations" IS 'Stores AI provider configurations with user-defined nicknames';

COMMENT ON COLUMN "public"."provider_configurations"."nickname" IS 'User-defined nickname for the provider configuration';

COMMENT ON COLUMN "public"."provider_configurations"."is_default" IS 'Whether this is the default provider for the user';


CREATE TABLE IF NOT EXISTS "public"."trading_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "portfolio_id" "uuid",
    "ticker" "text" NOT NULL,
    "action" "text" NOT NULL,
    "shares" numeric(15,4) NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "agent" "text",
    "reasoning" "text",
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "executed_at" timestamp with time zone,
    "source_type" "text" DEFAULT 'individual_analysis'::"text",
    "position_percentage" numeric,
    "target_value" numeric,
    "user_approved_at" timestamp with time zone,
    "auto_executed" boolean DEFAULT false,
    "analysis_id" "uuid",
    "dollar_amount" numeric(15,2) DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "alpaca_order_id" "text",
    "alpaca_order_status" "text",
    "alpaca_filled_qty" numeric(15,4),
    "alpaca_filled_price" numeric(10,2),
    CONSTRAINT "trading_actions_action_check" CHECK (("action" = ANY (ARRAY['BUY'::"text", 'SELL'::"text"]))),
    CONSTRAINT "trading_actions_order_validation" CHECK (((("shares" > (0)::numeric) AND ("dollar_amount" = (0)::numeric)) OR (("shares" = (0)::numeric) AND ("dollar_amount" > (0)::numeric)) OR (("shares" = (0)::numeric) AND ("dollar_amount" = (0)::numeric) AND ("action" = 'HOLD'::"text")))),
    CONSTRAINT "trading_actions_source_type_check" CHECK (("source_type" = ANY (ARRAY['individual_analysis'::"text"]))));

ALTER TABLE "public"."trading_actions" OWNER TO "postgres";

COMMENT ON TABLE "public"."trading_actions" IS 'User trading actions with RLS enabled for data isolation';

COMMENT ON COLUMN "public"."trading_actions"."status" IS 'Trade order status: pending (awaiting user decision), approved (user approved), rejected (user rejected)';

COMMENT ON COLUMN "public"."trading_actions"."user_approved_at" IS 'Timestamp when user manually approved this trade';

COMMENT ON COLUMN "public"."trading_actions"."auto_executed" IS 'Whether this trade was auto-executed without manual approval';

COMMENT ON COLUMN "public"."trading_actions"."analysis_id" IS 'Links trade order to the analysis that generated the recommendation';

COMMENT ON COLUMN "public"."trading_actions"."dollar_amount" IS 'Dollar amount for the trade order (alternative to specifying shares)';

COMMENT ON COLUMN "public"."trading_actions"."metadata" IS 'JSONB field storing additional trade metadata including:
- beforePosition: {shares, value, allocation}
- afterPosition: {shares, value, allocation}
- changes: {shares, value, allocation}
- alpaca_order: {
    id: Alpaca order ID,
    client_order_id: Client order ID,
    status: Order status (pending, filled, canceled, rejected),
    created_at: Order creation timestamp,
    submitted_at: Order submission timestamp,
    type: Order type (market, limit, stop, etc),
    time_in_force: Time in force (day, gtc, etc),
    filled_qty: Filled quantity,
    filled_avg_price: Average fill price,
    updated_at: Last update timestamp
  }';

COMMENT ON COLUMN "public"."trading_actions"."alpaca_order_id" IS 'Alpaca order ID linked to this AI trade decision';

COMMENT ON COLUMN "public"."trading_actions"."alpaca_order_status" IS 'Current status of the linked Alpaca order';

COMMENT ON COLUMN "public"."trading_actions"."alpaca_filled_qty" IS 'Quantity filled by Alpaca for this order';

COMMENT ON COLUMN "public"."trading_actions"."alpaca_filled_price" IS 'Average filled price by Alpaca for this order';

CREATE TABLE IF NOT EXISTS "public"."target_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "target_percentage" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "target_allocations_target_percentage_check" CHECK ((("target_percentage" >= (0)::numeric) AND ("target_percentage" <= (100)::numeric)))
);

ALTER TABLE "public"."target_allocations" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."trade_orders_detailed" WITH ("security_invoker"='true') AS
 SELECT "ta"."id",
    "ta"."user_id",
    "ta"."ticker",
    "ta"."action",
    "ta"."shares",
    "ta"."dollar_amount",
    "ta"."price",
    "ta"."status",
    "ta"."agent",
    "ta"."reasoning",
    "ta"."created_at",
    "ta"."executed_at",
    "ta"."source_type",
    "ta"."analysis_id",
    "ta"."auto_executed",
    "ta"."metadata",
    ((("ta"."metadata" -> 'beforePosition'::"text") ->> 'shares'::"text"))::numeric AS "before_shares",
    ((("ta"."metadata" -> 'beforePosition'::"text") ->> 'value'::"text"))::numeric AS "before_value",
    ((("ta"."metadata" -> 'beforePosition'::"text") ->> 'allocation'::"text"))::numeric AS "before_allocation",
    ((("ta"."metadata" -> 'afterPosition'::"text") ->> 'shares'::"text"))::numeric AS "after_shares",
    ((("ta"."metadata" -> 'afterPosition'::"text") ->> 'value'::"text"))::numeric AS "after_value",
    ((("ta"."metadata" -> 'afterPosition'::"text") ->> 'allocation'::"text"))::numeric AS "after_allocation",
    ((("ta"."metadata" -> 'changes'::"text") ->> 'shares'::"text"))::numeric AS "shares_change",
    ((("ta"."metadata" -> 'changes'::"text") ->> 'value'::"text"))::numeric AS "value_change",
    ((("ta"."metadata" -> 'changes'::"text") ->> 'allocation'::"text"))::numeric AS "allocation_change",
        CASE
            WHEN ("ta"."dollar_amount" > (0)::numeric) THEN 'dollar_order'::"text"
            WHEN ("ta"."shares" > (0)::numeric) THEN 'share_order'::"text"
            ELSE 'hold'::"text"
        END AS "order_type",
    "ah"."ticker" AS "analysis_ticker",
    "ah"."decision" AS "analysis_decision",
    "ah"."confidence" AS "analysis_confidence"
   FROM "public"."trading_actions" "ta"
     LEFT JOIN "public"."analysis_history" "ah" ON (("ta"."analysis_id" = "ah"."id"));

CREATE TABLE IF NOT EXISTS "public"."user_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "usage_date" "date" DEFAULT CURRENT_DATE,
    "analysis_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."user_usage" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."watchlist" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "added_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "last_analysis" timestamp with time zone,
    "last_decision" "text",
    CONSTRAINT "watchlist_last_decision_check" CHECK (("last_decision" = ANY (ARRAY['BUY'::"text", 'SELL'::"text", 'HOLD'::"text"])))
);

ALTER TABLE "public"."watchlist" OWNER TO "postgres";

ALTER TABLE ONLY "public"."analysis_history"
    ADD CONSTRAINT "analysis_history_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."analysis_messages"
    ADD CONSTRAINT "analysis_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_user_id_key" UNIQUE ("user_id");

ALTER TABLE ONLY "public"."market_data_cache"
    ADD CONSTRAINT "market_data_cache_pkey" PRIMARY KEY ("ticker", "timeframe", "fetched_date");

ALTER TABLE ONLY "public"."portfolios"
    ADD CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_portfolio_id_ticker_key" UNIQUE ("portfolio_id", "ticker");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."provider_configurations"
    ADD CONSTRAINT "provider_configurations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."provider_configurations"
    ADD CONSTRAINT "provider_configurations_user_id_nickname_key" UNIQUE ("user_id", "nickname");

ALTER TABLE ONLY "public"."target_allocations"
    ADD CONSTRAINT "target_allocations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."target_allocations"
    ADD CONSTRAINT "target_allocations_user_id_ticker_key" UNIQUE ("user_id", "ticker");

ALTER TABLE ONLY "public"."trading_actions"
    ADD CONSTRAINT "trading_actions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_usage"
    ADD CONSTRAINT "user_usage_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_usage"
    ADD CONSTRAINT "user_usage_user_id_usage_date_key" UNIQUE ("user_id", "usage_date");

ALTER TABLE ONLY "public"."watchlist"
    ADD CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."watchlist"
    ADD CONSTRAINT "watchlist_user_id_ticker_key" UNIQUE ("user_id", "ticker");

CREATE INDEX "idx_analysis_history_canceled" ON "public"."analysis_history" USING "btree" ("user_id", "is_canceled") WHERE ("is_canceled" = true);

CREATE INDEX "idx_analysis_history_status" ON "public"."analysis_history" USING "btree" ("analysis_status");

CREATE INDEX "idx_analysis_history_user_status" ON "public"."analysis_history" USING "btree" ("user_id", "analysis_status");

CREATE INDEX "idx_analysis_messages_analysis_id" ON "public"."analysis_messages" USING "btree" ("analysis_id");

CREATE INDEX "idx_analysis_messages_created_at" ON "public"."analysis_messages" USING "btree" ("created_at");

CREATE INDEX "idx_analysis_messages_metadata" ON "public"."analysis_messages" USING "gin" ("metadata") WHERE ("metadata" IS NOT NULL);

CREATE INDEX "idx_api_settings_opportunity_agent" ON "public"."api_settings" USING "btree" ("user_id", "opportunity_agent_ai") WHERE ("opportunity_agent_ai" IS NOT NULL);

CREATE INDEX "idx_api_settings_opportunity_provider" ON "public"."api_settings" USING "btree" ("user_id", "opportunity_agent_provider_id") WHERE ("opportunity_agent_provider_id" IS NOT NULL);

CREATE INDEX "idx_api_settings_portfolio_manager" ON "public"."api_settings" USING "btree" ("user_id", "portfolio_manager_ai") WHERE ("portfolio_manager_ai" IS NOT NULL);

CREATE INDEX "idx_api_settings_portfolio_manager_provider" ON "public"."api_settings" USING "btree" ("portfolio_manager_provider_id") WHERE ("portfolio_manager_provider_id" IS NOT NULL);

CREATE INDEX "idx_api_settings_risk_level" ON "public"."api_settings" USING "btree" ("user_id", "user_risk_level");

CREATE INDEX "idx_market_cache_ny_date" ON "public"."market_data_cache" USING "btree" ("ticker", "timeframe", "fetched_date" DESC) WHERE ("fetched_date" = "public"."get_ny_current_date"());

CREATE INDEX "idx_market_cache_ticker_timeframe_date" ON "public"."market_data_cache" USING "btree" ("ticker", "timeframe", "fetched_date" DESC);

CREATE INDEX "idx_target_allocations_user" ON "public"."target_allocations" USING "btree" ("user_id");

CREATE INDEX "idx_trading_actions_alpaca_order" ON "public"."trading_actions" USING "btree" ("alpaca_order_id") WHERE ("alpaca_order_id" IS NOT NULL);

CREATE INDEX "idx_trading_actions_alpaca_order_id" ON "public"."trading_actions" USING "btree" (((("metadata" -> 'alpaca_order'::"text") ->> 'id'::"text"))) WHERE ((("metadata" -> 'alpaca_order'::"text") ->> 'id'::"text") IS NOT NULL);

CREATE INDEX "idx_trading_actions_alpaca_status" ON "public"."trading_actions" USING "btree" (((("metadata" -> 'alpaca_order'::"text") ->> 'status'::"text"))) WHERE ((("metadata" -> 'alpaca_order'::"text") ->> 'status'::"text") IS NOT NULL);

CREATE INDEX "idx_trading_actions_analysis" ON "public"."trading_actions" USING "btree" ("analysis_id") WHERE ("analysis_id" IS NOT NULL);

CREATE INDEX "idx_trading_actions_composite" ON "public"."trading_actions" USING "btree" ("user_id", "created_at" DESC, "status") WHERE ("status" = ANY (ARRAY['pending'::"text", 'approved'::"text"]));

CREATE INDEX "idx_trading_actions_dollar_orders" ON "public"."trading_actions" USING "btree" ("user_id", "created_at" DESC) WHERE ("dollar_amount" > (0)::numeric);

CREATE INDEX "idx_trading_actions_metadata_gin" ON "public"."trading_actions" USING "gin" ("metadata");

CREATE INDEX "idx_trading_actions_source_analysis" ON "public"."trading_actions" USING "btree" ("source_type", "analysis_id") WHERE ("source_type" = 'individual_analysis'::"text");

CREATE INDEX "idx_trading_actions_status" ON "public"."trading_actions" USING "btree" ("status");

CREATE INDEX "idx_trading_actions_user_created" ON "public"."trading_actions" USING "btree" ("user_id", "created_at" DESC);

CREATE INDEX "idx_trading_actions_user_status" ON "public"."trading_actions" USING "btree" ("user_id", "status");

CREATE INDEX "idx_user_usage_user_date" ON "public"."user_usage" USING "btree" ("user_id", "usage_date");

CREATE OR REPLACE TRIGGER "handle_api_settings_updated_at" BEFORE UPDATE ON "public"."api_settings" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();

CREATE OR REPLACE TRIGGER "handle_portfolios_updated_at" BEFORE UPDATE ON "public"."portfolios" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();

CREATE OR REPLACE TRIGGER "handle_positions_updated_at" BEFORE UPDATE ON "public"."positions" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();

CREATE OR REPLACE TRIGGER "handle_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();

CREATE OR REPLACE TRIGGER "update_analysis_history_updated_at" BEFORE UPDATE ON "public"."analysis_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

CREATE OR REPLACE TRIGGER "update_market_cache_updated_at" BEFORE UPDATE ON "public"."market_data_cache" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

CREATE OR REPLACE TRIGGER "update_provider_configurations_updated_at" BEFORE UPDATE ON "public"."provider_configurations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

CREATE OR REPLACE TRIGGER "update_user_usage_updated_at" BEFORE UPDATE ON "public"."user_usage" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();

CREATE OR REPLACE TRIGGER "validate_analysis_reference" BEFORE INSERT OR UPDATE ON "public"."trading_actions" FOR EACH ROW EXECUTE FUNCTION "public"."check_analysis_exists"();

CREATE OR REPLACE TRIGGER "validate_trade_order_trigger" BEFORE INSERT OR UPDATE ON "public"."trading_actions" FOR EACH ROW EXECUTE FUNCTION "public"."validate_trade_order"();

ALTER TABLE ONLY "public"."analysis_history"
    ADD CONSTRAINT "analysis_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."analysis_messages"
    ADD CONSTRAINT "analysis_messages_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_history"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_analysis_team_provider_id_fkey" FOREIGN KEY ("analysis_team_provider_id") REFERENCES "public"."provider_configurations"("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_default_provider_id_fkey" FOREIGN KEY ("default_provider_id") REFERENCES "public"."provider_configurations"("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_opportunity_agent_provider_id_fkey" FOREIGN KEY ("opportunity_agent_provider_id") REFERENCES "public"."provider_configurations"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_portfolio_manager_provider_id_fkey" FOREIGN KEY ("portfolio_manager_provider_id") REFERENCES "public"."provider_configurations"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_research_team_provider_id_fkey" FOREIGN KEY ("research_team_provider_id") REFERENCES "public"."provider_configurations"("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_risk_team_provider_id_fkey" FOREIGN KEY ("risk_team_provider_id") REFERENCES "public"."provider_configurations"("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_trading_team_provider_id_fkey" FOREIGN KEY ("trading_team_provider_id") REFERENCES "public"."provider_configurations"("id");

ALTER TABLE ONLY "public"."api_settings"
    ADD CONSTRAINT "api_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."portfolios"
    ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."provider_configurations"
    ADD CONSTRAINT "provider_configurations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."target_allocations"
    ADD CONSTRAINT "target_allocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."trading_actions"
    ADD CONSTRAINT "trading_actions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_history"("id") ON DELETE CASCADE;

COMMENT ON CONSTRAINT "trading_actions_analysis_id_fkey" ON "public"."trading_actions" IS 'Ensures trade actions are deleted when their linked analysis is deleted (CASCADE DELETE)';

ALTER TABLE ONLY "public"."trading_actions"
    ADD CONSTRAINT "trading_actions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."trading_actions"
    ADD CONSTRAINT "trading_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_usage"
    ADD CONSTRAINT "user_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."watchlist"
    ADD CONSTRAINT "watchlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

CREATE POLICY "Allow authenticated users to read market cache" ON "public"."market_data_cache" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "Allow service role full access to market cache" ON "public"."market_data_cache" TO "service_role" USING (true);

CREATE POLICY "Service role can insert messages" ON "public"."analysis_messages" FOR INSERT WITH CHECK (true);

CREATE POLICY "Service role can update messages" ON "public"."analysis_messages" FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to analysis history" ON "public"."analysis_history" TO "service_role" USING (true) WITH CHECK (true);

CREATE POLICY "System can manage usage" ON "public"."user_usage" USING (true);

CREATE POLICY "Users can create own analysis history" ON "public"."analysis_history" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "Users can create own portfolios" ON "public"."portfolios" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can create own trading actions" ON "public"."trading_actions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can create their own provider configurations" ON "public"."provider_configurations" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can delete own analysis history" ON "public"."analysis_history" FOR DELETE USING (("user_id" = "auth"."uid"()));

CREATE POLICY "Users can delete own portfolios" ON "public"."portfolios" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can delete own target allocations" ON "public"."target_allocations" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can delete their own provider configurations" ON "public"."provider_configurations" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can insert own target allocations" ON "public"."target_allocations" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can insert their own provider configurations" ON "public"."provider_configurations" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can manage own watchlist" ON "public"."watchlist" USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can manage positions in own portfolios" ON "public"."positions" USING ((EXISTS ( SELECT 1
   FROM "public"."portfolios"
  WHERE (("portfolios"."id" = "positions"."portfolio_id") AND ("portfolios"."user_id" = "auth"."uid"())))));

CREATE POLICY "Users can read their own analysis messages" ON "public"."analysis_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."analysis_history" "ah"
  WHERE (("ah"."id" = "analysis_messages"."analysis_id") AND ("ah"."user_id" = "auth"."uid"())))));

CREATE POLICY "Users can update own analysis history" ON "public"."analysis_history" FOR UPDATE USING (("user_id" = "auth"."uid"()));

CREATE POLICY "Users can update own portfolios" ON "public"."portfolios" FOR UPDATE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can update own target allocations" ON "public"."target_allocations" FOR UPDATE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can update own trading actions" ON "public"."trading_actions" FOR UPDATE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can update their own provider configurations" ON "public"."provider_configurations" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view own analysis history" ON "public"."analysis_history" FOR SELECT USING (("user_id" = "auth"."uid"()));

CREATE POLICY "Users can view own detailed trade orders" ON "public"."trading_actions" FOR SELECT USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view own portfolios" ON "public"."portfolios" FOR SELECT USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));

CREATE POLICY "Users can view own target allocations" ON "public"."target_allocations" FOR SELECT USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view own trading actions" ON "public"."trading_actions" FOR SELECT USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view own usage" ON "public"."user_usage" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

CREATE POLICY "Users can view own watchlist" ON "public"."watchlist" FOR SELECT USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view positions in own portfolios" ON "public"."positions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."portfolios"
  WHERE (("portfolios"."id" = "positions"."portfolio_id") AND ("portfolios"."user_id" = "auth"."uid"())))));

CREATE POLICY "Users can view their own provider configurations" ON "public"."provider_configurations" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

CREATE POLICY "Users can view their own usage" ON "public"."user_usage" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."analysis_history" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."analysis_messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."api_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_settings_delete_own" ON "public"."api_settings" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));

COMMENT ON POLICY "api_settings_delete_own" ON "public"."api_settings" IS 'Users can delete their own API settings';

CREATE POLICY "api_settings_insert_own" ON "public"."api_settings" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

COMMENT ON POLICY "api_settings_insert_own" ON "public"."api_settings" IS 'Users can create their own API settings';

CREATE POLICY "api_settings_select_own" ON "public"."api_settings" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

COMMENT ON POLICY "api_settings_select_own" ON "public"."api_settings" IS 'Users can view their own API settings';

CREATE POLICY "api_settings_service_role_all" ON "public"."api_settings" TO "service_role" USING (true) WITH CHECK (true);

COMMENT ON POLICY "api_settings_service_role_all" ON "public"."api_settings" IS 'Service role has full access (for Edge Functions)';

CREATE POLICY "api_settings_update_own" ON "public"."api_settings" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

COMMENT ON POLICY "api_settings_update_own" ON "public"."api_settings" IS 'Users can update their own API settings';

ALTER TABLE "public"."market_data_cache" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_data_cache_access_policy" ON "public"."market_data_cache" FOR SELECT USING ((("current_setting"('role'::"text") = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL)));

COMMENT ON POLICY "market_data_cache_access_policy" ON "public"."market_data_cache" IS 'Controls access to market data cache: service_role and all authenticated users';

ALTER TABLE "public"."portfolios" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."positions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_self_access" ON "public"."profiles" TO "authenticated" USING (("id" = "auth"."uid"()));

ALTER TABLE "public"."provider_configurations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."target_allocations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."trading_actions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trading_actions_user_access" ON "public"."trading_actions" FOR SELECT USING ((("current_setting"('role'::"text") = 'service_role'::"text") OR ("user_id" = "auth"."uid"())));

ALTER TABLE "public"."user_usage" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_update_own_profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));

CREATE POLICY "users_view_own_profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));

ALTER TABLE "public"."watchlist" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."check_analysis_exists"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_analysis_exists"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_analysis_exists"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_ny_current_date"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_ny_current_date"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ny_current_date"() TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."sync_user_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_user_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_user_profile"() TO "service_role";

GRANT ALL ON FUNCTION "public"."update_debate_round"("p_analysis_id" "uuid", "p_round" integer, "p_agent_type" "text", "p_response" "text", "p_points" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."update_debate_round"("p_analysis_id" "uuid", "p_round" integer, "p_agent_type" "text", "p_response" "text", "p_points" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_debate_round"("p_analysis_id" "uuid", "p_round" integer, "p_agent_type" "text", "p_response" "text", "p_points" "text"[]) TO "service_role";

GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";

GRANT ALL ON FUNCTION "public"."update_workflow_step_status"("p_analysis_id" "uuid", "p_phase_id" "text", "p_agent_name" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_workflow_step_status"("p_analysis_id" "uuid", "p_phase_id" "text", "p_agent_name" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_workflow_step_status"("p_analysis_id" "uuid", "p_phase_id" "text", "p_agent_name" "text", "p_status" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."validate_trade_order"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_trade_order"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_trade_order"() TO "service_role";

GRANT ALL ON TABLE "public"."analysis_history" TO "anon";
GRANT ALL ON TABLE "public"."analysis_history" TO "authenticated";
GRANT ALL ON TABLE "public"."analysis_history" TO "service_role";

GRANT ALL ON TABLE "public"."analysis_messages" TO "anon";
GRANT ALL ON TABLE "public"."analysis_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."analysis_messages" TO "service_role";

GRANT ALL ON TABLE "public"."api_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."api_settings" TO "service_role";

GRANT ALL ON TABLE "public"."api_settings_unified" TO "authenticated";
GRANT ALL ON TABLE "public"."api_settings_unified" TO "service_role";

GRANT ALL ON TABLE "public"."market_data_cache" TO "anon";
GRANT ALL ON TABLE "public"."market_data_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."market_data_cache" TO "service_role";

GRANT ALL ON TABLE "public"."market_cache_status" TO "authenticated";
GRANT ALL ON TABLE "public"."market_cache_status" TO "service_role";

GRANT ALL ON TABLE "public"."portfolios" TO "anon";
GRANT ALL ON TABLE "public"."portfolios" TO "authenticated";
GRANT ALL ON TABLE "public"."portfolios" TO "service_role";

GRANT ALL ON TABLE "public"."positions" TO "anon";
GRANT ALL ON TABLE "public"."positions" TO "authenticated";
GRANT ALL ON TABLE "public"."positions" TO "service_role";

GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";

GRANT ALL ON TABLE "public"."provider_configurations" TO "anon";
GRANT ALL ON TABLE "public"."provider_configurations" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_configurations" TO "service_role";

GRANT ALL ON TABLE "public"."trading_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."trading_actions" TO "service_role";

GRANT ALL ON TABLE "public"."target_allocations" TO "anon";
GRANT ALL ON TABLE "public"."target_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."target_allocations" TO "service_role";

GRANT ALL ON TABLE "public"."trade_orders_detailed" TO "authenticated";
GRANT ALL ON TABLE "public"."trade_orders_detailed" TO "service_role";

GRANT ALL ON TABLE "public"."user_usage" TO "anon";
GRANT ALL ON TABLE "public"."user_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."user_usage" TO "service_role";

GRANT ALL ON TABLE "public"."watchlist" TO "anon";
GRANT ALL ON TABLE "public"."watchlist" TO "authenticated";
GRANT ALL ON TABLE "public"."watchlist" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

RESET ALL;
