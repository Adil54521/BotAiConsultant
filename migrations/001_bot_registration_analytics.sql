BEGIN;

ALTER TABLE ai_conversations
    ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS first_name text,
    ADD COLUMN IF NOT EXISTS last_name text,
    ADD COLUMN IF NOT EXISTS registered_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_registered_at
    ON ai_conversations (registered_at);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_last_activity_at
    ON ai_conversations (last_activity_at);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_phone
    ON ai_conversations (phone);

CREATE TABLE IF NOT EXISTS ai_usage_events (
    request_id uuid PRIMARY KEY,
    conversation_id integer NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL DEFAULT now(),
    model text NOT NULL,
    route text,
    status text NOT NULL CHECK (status IN ('success', 'error', 'ignored')),
    prompt_tokens integer,
    candidate_tokens integer,
    thoughts_tokens integer,
    total_tokens integer,
    cached_tokens integer,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    error_type text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_requested_at
    ON ai_usage_events (requested_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_conversation_date
    ON ai_usage_events (conversation_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_status_date
    ON ai_usage_events (status, requested_at);

CREATE TABLE IF NOT EXISTS support_requests (
    id bigserial PRIMARY KEY,
    conversation_id integer NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    opened_at timestamptz NOT NULL DEFAULT now(),
    operator_connected_at timestamptz,
    closed_at timestamptz,
    status text NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'active', 'closed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_support_requests_opened_at
    ON support_requests (opened_at);
CREATE INDEX IF NOT EXISTS idx_support_requests_conversation_date
    ON support_requests (conversation_id, opened_at);

COMMIT;
