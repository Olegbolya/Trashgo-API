CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" varchar(200) PRIMARY KEY NOT NULL,
  "count" integer NOT NULL DEFAULT 1,
  "reset_at" timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_rate_limits_reset" ON "rate_limits" ("reset_at");
