-- Manual, non-destructive migration for POST /internal/bot-user/register.
-- Review the preflight queries from the accompanying report before execution.
BEGIN;

DO $preflight$
DECLARE
    duplicate_groups bigint;
BEGIN
    IF to_regclass('public.chats') IS NULL THEN
        RAISE EXCEPTION 'Required table public.chats does not exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'public.chats'::regclass
          AND attname = 'student_id'
          AND NOT attisdropped
          AND atttypid = 'bigint'::regtype
    ) THEN
        RAISE EXCEPTION 'public.chats.student_id must exist and have type bigint';
    END IF;

    IF EXISTS (SELECT 1 FROM public.chats WHERE student_id IS NULL) THEN
        RAISE EXCEPTION 'public.chats contains NULL student_id values; manual review is required';
    END IF;

    SELECT count(*) INTO duplicate_groups
    FROM (
        SELECT student_id
        FROM public.chats
        GROUP BY student_id
        HAVING count(*) > 1
    ) duplicates;

    IF duplicate_groups > 0 THEN
        RAISE EXCEPTION
            'public.chats contains % duplicated student_id group(s); no data was changed',
            duplicate_groups;
    END IF;
END
$preflight$;

-- Prevent concurrent INSERTs while constraints and sequence state are inspected.
LOCK TABLE public.chats IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.chats
    ADD COLUMN IF NOT EXISTS username text,
    ADD COLUMN IF NOT EXISTS first_name text,
    ADD COLUMN IF NOT EXISTS last_name text,
    ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

DO $type_check$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'public.chats'::regclass
          AND NOT a.attisdropped
          AND (
              (a.attname IN ('username', 'first_name', 'last_name')
               AND a.atttypid NOT IN ('text'::regtype, 'character varying'::regtype))
              OR (a.attname = 'phone_verified' AND a.atttypid <> 'boolean'::regtype)
              OR (a.attname = 'last_activity_at'
                  AND a.atttypid <> 'timestamp with time zone'::regtype)
          )
    ) THEN
        RAISE EXCEPTION 'One or more registration columns exist with an incompatible type';
    END IF;
END
$type_check$;

-- If phone_verified was created earlier as nullable, normalize only NULL flags.
ALTER TABLE public.chats
    ALTER COLUMN phone_verified SET DEFAULT false;

UPDATE public.chats
SET phone_verified = false
WHERE phone_verified IS NULL;

ALTER TABLE public.chats
    ALTER COLUMN phone_verified SET NOT NULL,
    ALTER COLUMN student_id SET NOT NULL;

-- A unique index is sufficient for INSERT ... ON CONFLICT (student_id).
-- Do not create a duplicate index when one already exists under another name.
DO $unique_index$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = 'public.chats'::regclass
          AND i.indisunique
          AND i.indisvalid
          AND i.indisready
          AND i.indpred IS NULL
          AND i.indexprs IS NULL
          AND i.indnkeyatts = 1
          AND i.indkey[0] = (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'public.chats'::regclass
                AND attname = 'student_id'
                AND NOT attisdropped
          )
    ) THEN
        CREATE UNIQUE INDEX uq_chats_student_id_registration
            ON public.chats (student_id);
    END IF;
END
$unique_index$;

-- Used by registration/admin lookups and period/activity reports.
CREATE INDEX IF NOT EXISTS idx_chats_created_at
    ON public.chats (created_at);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity_at
    ON public.chats (last_activity_at);

-- backup.sql inserts explicit chat IDs but does not synchronize chats_id_seq.
-- Align only the sequence; no chat row is inserted, updated, or deleted.
DO $sequence_check$
DECLARE
    default_expression text;
    next_chat_id bigint;
    sequence_last_value bigint;
    sequence_is_called boolean;
BEGIN
    IF to_regclass('public.chats_id_seq') IS NULL THEN
        RAISE EXCEPTION 'Required sequence public.chats_id_seq does not exist';
    END IF;

    SELECT pg_get_expr(d.adbin, d.adrelid)
    INTO default_expression
    FROM pg_attrdef d
    JOIN pg_attribute a
      ON a.attrelid = d.adrelid
     AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.chats'::regclass
      AND a.attname = 'id';

    IF default_expression IS NULL
       OR default_expression NOT LIKE 'nextval(%chats_id_seq%' THEN
        RAISE EXCEPTION
            'public.chats.id is not backed by public.chats_id_seq; manual review is required';
    END IF;

    SELECT last_value, is_called
    INTO sequence_last_value, sequence_is_called
    FROM public.chats_id_seq;

    SELECT GREATEST(
        COALESCE(max(id), 0) + 1,
        CASE WHEN sequence_is_called
             THEN sequence_last_value + 1
             ELSE sequence_last_value
        END,
        1
    )
    INTO next_chat_id
    FROM public.chats;

    PERFORM setval('public.chats_id_seq'::regclass, next_chat_id, false);
END
$sequence_check$;

COMMIT;
