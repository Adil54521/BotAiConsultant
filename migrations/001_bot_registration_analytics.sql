BEGIN;

-- Extend the existing Telegram user/chat table. No parallel user table is created.
ALTER TABLE chats
    ADD COLUMN IF NOT EXISTS username text,
    ADD COLUMN IF NOT EXISTS first_name text,
    ADD COLUMN IF NOT EXISTS last_name text,
    ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- Existing rows with a stored phone were registered before this flag existed.
UPDATE chats
SET phone_verified = true
WHERE phone IS NOT NULL
  AND btrim(phone) <> ''
  AND phone_verified = false;

CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats (phone);
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats (created_at);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity_at ON chats (last_activity_at);

-- Store AI/support metadata beside the existing conversation messages.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sent_to_bot boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'support_message',
    ADD COLUMN IF NOT EXISTS request_id uuid,
    ADD COLUMN IF NOT EXISTS model text,
    ADD COLUMN IF NOT EXISTS route text,
    ADD COLUMN IF NOT EXISTS status text,
    ADD COLUMN IF NOT EXISTS prompt_tokens integer,
    ADD COLUMN IF NOT EXISTS candidate_tokens integer,
    ADD COLUMN IF NOT EXISTS thoughts_tokens integer,
    ADD COLUMN IF NOT EXISTS total_tokens integer,
    ADD COLUMN IF NOT EXISTS cached_tokens integer,
    ADD COLUMN IF NOT EXISTS duration_ms integer,
    ADD COLUMN IF NOT EXISTS error_type text,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS telegram_message_id bigint,
    ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(14,8),
    ADD COLUMN IF NOT EXISTS pricing_effective_date date,
    ADD COLUMN IF NOT EXISTS search_query_count integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_request_id
    ON messages (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_chat_date
    ON messages (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_type_date
    ON messages (message_type, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_status_date
    ON messages (status, created_at) WHERE status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_source_date
    ON messages (source, created_at) WHERE message_type = 'ai_usage';

COMMIT;
