-- Migration: 006 User Display Name
-- Adds display_name to users for personalized greetings

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
