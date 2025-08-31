-- Migration to add missing position size and allocation columns to api_settings table
-- These columns are required for portfolio position sizing and allocation configuration

-- Add target_stock_allocation column if it doesn't exist
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "target_stock_allocation" numeric DEFAULT 80;

-- Add target_cash_allocation column if it doesn't exist
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "target_cash_allocation" numeric DEFAULT 20;

-- Add default_max_position_size column if it doesn't exist
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "default_max_position_size" numeric DEFAULT 25;

-- Add default_min_position_size column if it doesn't exist
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "default_min_position_size" numeric DEFAULT 2;

-- Add comments for the new columns
COMMENT ON COLUMN "public"."api_settings"."target_stock_allocation" IS 'Target percentage of portfolio to allocate to stocks (0-100)';
COMMENT ON COLUMN "public"."api_settings"."target_cash_allocation" IS 'Target percentage of portfolio to maintain as cash (0-100)';
COMMENT ON COLUMN "public"."api_settings"."default_max_position_size" IS 'Maximum position size as percentage of portfolio (0-100). Default: 25%';
COMMENT ON COLUMN "public"."api_settings"."default_min_position_size" IS 'Minimum position size as percentage of portfolio (0-100). Default: 2%';

-- Add check constraints for the new columns (using IF NOT EXISTS pattern)
DO $$ 
BEGIN
    -- Check constraint for target_stock_allocation
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_settings_target_stock_allocation_check'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "api_settings_target_stock_allocation_check" 
        CHECK ("target_stock_allocation" >= 0 AND "target_stock_allocation" <= 100);
    END IF;

    -- Check constraint for target_cash_allocation
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_settings_target_cash_allocation_check'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "api_settings_target_cash_allocation_check" 
        CHECK ("target_cash_allocation" >= 0 AND "target_cash_allocation" <= 100);
    END IF;

    -- Check constraint for default_max_position_size
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_settings_default_max_position_size_check'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "api_settings_default_max_position_size_check" 
        CHECK ("default_max_position_size" >= 0 AND "default_max_position_size" <= 100);
    END IF;

    -- Check constraint for default_min_position_size
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_settings_default_min_position_size_check'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "api_settings_default_min_position_size_check" 
        CHECK ("default_min_position_size" >= 0 AND "default_min_position_size" <= 100);
    END IF;

    -- Check constraint to ensure min is less than max
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_settings_position_size_order_check'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "api_settings_position_size_order_check" 
        CHECK ("default_min_position_size" <= "default_max_position_size");
    END IF;

    -- Check constraint to ensure allocations sum to 100
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_allocation_total'
    ) THEN
        ALTER TABLE "public"."api_settings" 
        ADD CONSTRAINT "check_allocation_total" 
        CHECK ("target_stock_allocation" + "target_cash_allocation" = 100);
    END IF;
END $$;

-- Update any existing rows to have sensible defaults if NULL
UPDATE "public"."api_settings"
SET 
    "target_stock_allocation" = COALESCE("target_stock_allocation", 80),
    "target_cash_allocation" = COALESCE("target_cash_allocation", 20),
    "default_max_position_size" = COALESCE("default_max_position_size", 25),
    "default_min_position_size" = COALESCE("default_min_position_size", 2)
WHERE 
    "target_stock_allocation" IS NULL 
    OR "target_cash_allocation" IS NULL
    OR "default_max_position_size" IS NULL 
    OR "default_min_position_size" IS NULL;