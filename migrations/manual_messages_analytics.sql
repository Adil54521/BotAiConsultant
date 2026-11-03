-- Manual migration for the existing messages table used by admin analytics.
-- No table or historical message is deleted.
BEGIN;

DO $preflight$
BEGIN
    IF to_regclass('public.messages') IS NULL THEN
        RAISE EXCEPTION 'Required table public.messages does not exist';
    END IF;
    IF to_regclass('public.chats') IS NULL THEN
        RAISE EXCEPTION 'Required table public.chats does not exist';
    END IF;
END
$preflight$;

LOCK TABLE public.messages IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.messages
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
    ADD COLUMN IF NOT EXISTS error_type text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_request_id
    ON public.messages (request_id)
    WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_chat_date
    ON public.messages (chat_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_type_date
    ON public.messages (message_type, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_status_date
    ON public.messages (status, created_at)
    WHERE status IS NOT NULL;

COMMIT;
