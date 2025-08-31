-- Migration to add missing position size columns to api_settings table
-- These columns are required for portfolio position sizing configuration

-- Add default_max_position_size column after target_cash_allocation
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "default_max_position_size" numeric DEFAULT 25;

-- Add default_min_position_size column after default_max_position_size
ALTER TABLE "public"."api_settings" 
ADD COLUMN IF NOT EXISTS "default_min_position_size" numeric DEFAULT 2;

-- Add comments for the new columns
COMMENT ON COLUMN "public"."api_settings"."default_max_position_size" IS 'Maximum position size as percentage of portfolio (0-100). Default: 25%';
COMMENT ON COLUMN "public"."api_settings"."default_min_position_size" IS 'Minimum position size as percentage of portfolio (0-100). Default: 2%';

-- Add check constraints for the new columns
ALTER TABLE "public"."api_settings" 
ADD CONSTRAINT "api_settings_default_max_position_size_check" 
CHECK ("default_max_position_size" >= 0 AND "default_max_position_size" <= 100);

ALTER TABLE "public"."api_settings" 
ADD CONSTRAINT "api_settings_default_min_position_size_check" 
CHECK ("default_min_position_size" >= 0 AND "default_min_position_size" <= 100);

-- Add a constraint to ensure min is less than max
ALTER TABLE "public"."api_settings" 
ADD CONSTRAINT "api_settings_position_size_order_check" 
CHECK ("default_min_position_size" <= "default_max_position_size");

-- Update any existing rows to have sensible defaults if NULL
UPDATE "public"."api_settings"
SET 
    "default_max_position_size" = COALESCE("default_max_position_size", 25),
    "default_min_position_size" = COALESCE("default_min_position_size", 2)
WHERE 
    "default_max_position_size" IS NULL 
    OR "default_min_position_size" IS NULL;