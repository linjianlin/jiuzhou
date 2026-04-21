CREATE TABLE IF NOT EXISTS public.online_battle_settlement_task (
    id character varying(128) PRIMARY KEY,
    battle_id character varying(128) NOT NULL,
    kind character varying(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    payload jsonb NOT NULL,
    error_message text,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_online_battle_settlement_battle
    ON public.online_battle_settlement_task USING btree (battle_id);

CREATE INDEX IF NOT EXISTS idx_online_battle_settlement_status
    ON public.online_battle_settlement_task USING btree (status, updated_at);
