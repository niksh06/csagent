-- I-144: the codex engine's optional api-key mode joins the pgcrypto store.
-- Widen the CHECK from 012 to the five current names. Account mode (the codex
-- default) stores nothing here — it uses the `codex login` session on disk.
-- Idempotent: drop-if-exists + re-add under the same stable constraint name.
ALTER TABLE credential_secrets
  DROP CONSTRAINT IF EXISTS credential_secrets_name_check;
ALTER TABLE credential_secrets
  ADD CONSTRAINT credential_secrets_name_check
  CHECK (name IN ('cursor_api_key', 'telegram_bot_token', 'anthropic_api_key', 'claude_code_oauth_token', 'openai_api_key'));
