--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3 (Debian 18.3-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: afdian_message_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.afdian_message_delivery (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    recipient_user_id character varying(64) NOT NULL,
    content text NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    last_error text,
    sent_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: afdian_message_delivery_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.afdian_message_delivery_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: afdian_message_delivery_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.afdian_message_delivery_id_seq OWNED BY public.afdian_message_delivery.id;


--
-- Name: afdian_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.afdian_order (
    id bigint NOT NULL,
    out_trade_no character varying(64) NOT NULL,
    custom_order_id character varying(128),
    sponsor_user_id character varying(64) NOT NULL,
    sponsor_private_id character varying(128),
    plan_id character varying(64),
    month_count integer DEFAULT 1 NOT NULL,
    total_amount character varying(32) NOT NULL,
    status integer NOT NULL,
    payload jsonb NOT NULL,
    redeem_code_id bigint,
    processed_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: afdian_order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.afdian_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: afdian_order_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.afdian_order_id_seq OWNED BY public.afdian_order.id;


--
-- Name: arena_battle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arena_battle (
    battle_id character varying(128) NOT NULL,
    challenger_character_id integer NOT NULL,
    opponent_character_id integer NOT NULL,
    status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    result character varying(16),
    delta_score integer DEFAULT 0 NOT NULL,
    score_before integer,
    score_after integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: TABLE arena_battle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.arena_battle IS '竞技场挑战记录表（每次挑战一条记录）';


--
-- Name: COLUMN arena_battle.battle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.battle_id IS '战斗ID（与战斗系统battleId一致）';


--
-- Name: COLUMN arena_battle.challenger_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.challenger_character_id IS '挑战者角色ID';


--
-- Name: COLUMN arena_battle.opponent_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.opponent_character_id IS '被挑战者角色ID';


--
-- Name: COLUMN arena_battle.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.status IS '状态（running进行中/finished已结算）';


--
-- Name: COLUMN arena_battle.result; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.result IS '结果（win胜/lose败/draw平）';


--
-- Name: COLUMN arena_battle.delta_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.delta_score IS '挑战者积分变化（按双方分差与胜负动态计算）';


--
-- Name: COLUMN arena_battle.score_before; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.score_before IS '结算前积分';


--
-- Name: COLUMN arena_battle.score_after; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.score_after IS '结算后积分';


--
-- Name: COLUMN arena_battle.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.created_at IS '创建时间';


--
-- Name: COLUMN arena_battle.finished_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_battle.finished_at IS '结算时间';


--
-- Name: arena_rating; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arena_rating (
    character_id integer NOT NULL,
    rating integer DEFAULT 1000 NOT NULL,
    win_count integer DEFAULT 0 NOT NULL,
    lose_count integer DEFAULT 0 NOT NULL,
    last_battle_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE arena_rating; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.arena_rating IS '竞技场积分表（每个角色的积分与胜负统计）';


--
-- Name: COLUMN arena_rating.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.character_id IS '角色ID';


--
-- Name: COLUMN arena_rating.rating; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.rating IS '当前积分（默认1000）';


--
-- Name: COLUMN arena_rating.win_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.win_count IS '胜场次数';


--
-- Name: COLUMN arena_rating.lose_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.lose_count IS '败场次数';


--
-- Name: COLUMN arena_rating.last_battle_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.last_battle_at IS '最近一次战斗时间';


--
-- Name: COLUMN arena_rating.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.created_at IS '创建时间';


--
-- Name: COLUMN arena_rating.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_rating.updated_at IS '更新时间';


--
-- Name: arena_weekly_settlement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arena_weekly_settlement (
    week_start_local_date date NOT NULL,
    week_end_local_date date NOT NULL,
    window_start_at timestamp with time zone NOT NULL,
    window_end_at timestamp with time zone NOT NULL,
    champion_character_id integer,
    runnerup_character_id integer,
    third_character_id integer,
    settled_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE arena_weekly_settlement; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.arena_weekly_settlement IS '竞技场周结算记录（幂等控制：每周仅结算一次）';


--
-- Name: COLUMN arena_weekly_settlement.week_start_local_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.week_start_local_date IS '结算周起始日期（Asia/Shanghai，周一）';


--
-- Name: COLUMN arena_weekly_settlement.week_end_local_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.week_end_local_date IS '结算周结束日期（Asia/Shanghai，下周一）';


--
-- Name: COLUMN arena_weekly_settlement.window_start_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.window_start_at IS '结算窗口开始时间（UTC存储）';


--
-- Name: COLUMN arena_weekly_settlement.window_end_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.window_end_at IS '结算窗口结束时间（UTC存储）';


--
-- Name: COLUMN arena_weekly_settlement.champion_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.champion_character_id IS '周结算第1名角色ID';


--
-- Name: COLUMN arena_weekly_settlement.runnerup_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.runnerup_character_id IS '周结算第2名角色ID';


--
-- Name: COLUMN arena_weekly_settlement.third_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.third_character_id IS '周结算第3名角色ID';


--
-- Name: COLUMN arena_weekly_settlement.settled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.settled_at IS '结算写入时间';


--
-- Name: COLUMN arena_weekly_settlement.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.arena_weekly_settlement.updated_at IS '最近更新时间';


--
-- Name: battle_pass_claim_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_pass_claim_record (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    season_id character varying(64) NOT NULL,
    level integer NOT NULL,
    track character varying(16) NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE battle_pass_claim_record; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.battle_pass_claim_record IS '战令奖励领取记录表';


--
-- Name: COLUMN battle_pass_claim_record.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.id IS '领取记录ID';


--
-- Name: COLUMN battle_pass_claim_record.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.character_id IS '角色ID';


--
-- Name: COLUMN battle_pass_claim_record.season_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.season_id IS '赛季ID';


--
-- Name: COLUMN battle_pass_claim_record.level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.level IS '等级';


--
-- Name: COLUMN battle_pass_claim_record.track; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.track IS '奖励轨道（free/premium）';


--
-- Name: COLUMN battle_pass_claim_record.claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_claim_record.claimed_at IS '领取时间';


--
-- Name: battle_pass_claim_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.battle_pass_claim_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: battle_pass_claim_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.battle_pass_claim_record_id_seq OWNED BY public.battle_pass_claim_record.id;


--
-- Name: battle_pass_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_pass_progress (
    character_id integer NOT NULL,
    season_id character varying(64) NOT NULL,
    exp bigint DEFAULT 0 NOT NULL,
    premium_unlocked boolean DEFAULT false NOT NULL,
    premium_unlocked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE battle_pass_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.battle_pass_progress IS '角色战令进度表';


--
-- Name: COLUMN battle_pass_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.character_id IS '角色ID';


--
-- Name: COLUMN battle_pass_progress.season_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.season_id IS '赛季ID';


--
-- Name: COLUMN battle_pass_progress.exp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.exp IS '当前经验';


--
-- Name: COLUMN battle_pass_progress.premium_unlocked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.premium_unlocked IS '是否解锁特权';


--
-- Name: COLUMN battle_pass_progress.premium_unlocked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.premium_unlocked_at IS '解锁特权时间';


--
-- Name: COLUMN battle_pass_progress.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.created_at IS '创建时间';


--
-- Name: COLUMN battle_pass_progress.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_progress.updated_at IS '更新时间';


--
-- Name: battle_pass_task_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_pass_task_progress (
    character_id integer NOT NULL,
    season_id character varying(64) NOT NULL,
    task_id character varying(64) NOT NULL,
    progress_value bigint DEFAULT 0 NOT NULL,
    completed boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    claimed boolean DEFAULT false NOT NULL,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE battle_pass_task_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.battle_pass_task_progress IS '角色战令任务进度表';


--
-- Name: COLUMN battle_pass_task_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.character_id IS '角色ID';


--
-- Name: COLUMN battle_pass_task_progress.season_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.season_id IS '赛季ID';


--
-- Name: COLUMN battle_pass_task_progress.task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.task_id IS '任务ID';


--
-- Name: COLUMN battle_pass_task_progress.progress_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.progress_value IS '当前进度值';


--
-- Name: COLUMN battle_pass_task_progress.completed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.completed IS '是否完成';


--
-- Name: COLUMN battle_pass_task_progress.completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.completed_at IS '完成时间';


--
-- Name: COLUMN battle_pass_task_progress.claimed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.claimed IS '是否已领取';


--
-- Name: COLUMN battle_pass_task_progress.claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.claimed_at IS '领取时间';


--
-- Name: COLUMN battle_pass_task_progress.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.created_at IS '创建时间';


--
-- Name: COLUMN battle_pass_task_progress.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battle_pass_task_progress.updated_at IS '更新时间';


--
-- Name: bounty_claim; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bounty_claim (
    id bigint NOT NULL,
    bounty_instance_id bigint NOT NULL,
    character_id integer NOT NULL,
    status character varying(16) DEFAULT 'claimed'::character varying NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE bounty_claim; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bounty_claim IS '悬赏接取记录表（记录角色对悬赏的接取情况）';


--
-- Name: COLUMN bounty_claim.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.id IS '接取记录ID';


--
-- Name: COLUMN bounty_claim.bounty_instance_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.bounty_instance_id IS '悬赏实例ID';


--
-- Name: COLUMN bounty_claim.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.character_id IS '角色ID';


--
-- Name: COLUMN bounty_claim.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.status IS '状态（claimed已接取/completed已完成/rewarded已领奖/canceled已取消）';


--
-- Name: COLUMN bounty_claim.claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.claimed_at IS '接取时间';


--
-- Name: COLUMN bounty_claim.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_claim.updated_at IS '更新时间';


--
-- Name: bounty_claim_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bounty_claim_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bounty_claim_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bounty_claim_id_seq OWNED BY public.bounty_claim.id;


--
-- Name: bounty_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bounty_instance (
    id bigint NOT NULL,
    source_type character varying(16) DEFAULT 'daily'::character varying NOT NULL,
    bounty_def_id character varying(64),
    task_id character varying(64) NOT NULL,
    title character varying(128) NOT NULL,
    description text,
    claim_policy character varying(16) DEFAULT 'limited'::character varying NOT NULL,
    max_claims integer DEFAULT 0 NOT NULL,
    claimed_count integer DEFAULT 0 NOT NULL,
    refresh_date date,
    expires_at timestamp with time zone,
    published_by_character_id integer,
    spirit_stones_reward bigint DEFAULT 0 NOT NULL,
    silver_reward bigint DEFAULT 0 NOT NULL,
    spirit_stones_fee bigint DEFAULT 0 NOT NULL,
    silver_fee bigint DEFAULT 0 NOT NULL,
    required_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE bounty_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bounty_instance IS '悬赏实例表（每日刷新/玩家发布，动态数据）';


--
-- Name: COLUMN bounty_instance.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.id IS '悬赏实例ID';


--
-- Name: COLUMN bounty_instance.source_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.source_type IS '来源类型（daily每日/ player玩家）';


--
-- Name: COLUMN bounty_instance.bounty_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.bounty_def_id IS '关联悬赏定义ID（每日刷新来源）';


--
-- Name: COLUMN bounty_instance.task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.task_id IS '关联任务ID（静态或动态）';


--
-- Name: COLUMN bounty_instance.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.title IS '悬赏标题';


--
-- Name: COLUMN bounty_instance.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.description IS '悬赏描述';


--
-- Name: COLUMN bounty_instance.claim_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.claim_policy IS '接取规则（unique唯一/limited限次/unlimited不限）';


--
-- Name: COLUMN bounty_instance.max_claims; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.max_claims IS '总接取次数上限（limited时使用，0表示不限制）';


--
-- Name: COLUMN bounty_instance.claimed_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.claimed_count IS '已接取次数';


--
-- Name: COLUMN bounty_instance.refresh_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.refresh_date IS '每日刷新日期（source_type=daily时）';


--
-- Name: COLUMN bounty_instance.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.expires_at IS '过期时间（可为空）';


--
-- Name: COLUMN bounty_instance.published_by_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.published_by_character_id IS '发布者角色ID（玩家发布时）';


--
-- Name: COLUMN bounty_instance.spirit_stones_reward; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.spirit_stones_reward IS '灵石悬赏奖励（玩家发布）';


--
-- Name: COLUMN bounty_instance.silver_reward; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.silver_reward IS '银两悬赏奖励（玩家发布）';


--
-- Name: COLUMN bounty_instance.spirit_stones_fee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.spirit_stones_fee IS '灵石手续费（10%）';


--
-- Name: COLUMN bounty_instance.silver_fee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.silver_fee IS '银两手续费（10%）';


--
-- Name: COLUMN bounty_instance.required_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.required_items IS '提交材料要求（JSON数组：item_def_id/name/qty）';


--
-- Name: COLUMN bounty_instance.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.created_at IS '创建时间';


--
-- Name: COLUMN bounty_instance.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bounty_instance.updated_at IS '更新时间';


--
-- Name: bounty_instance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bounty_instance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bounty_instance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bounty_instance_id_seq OWNED BY public.bounty_instance.id;


--
-- Name: character_achievement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_achievement (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    achievement_id character varying(64) NOT NULL,
    status character varying(32) DEFAULT 'in_progress'::character varying NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    progress_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_achievement; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_achievement IS '角色成就进度表';


--
-- Name: COLUMN character_achievement.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_achievement.status IS '状态：in_progress/completed/claimed';


--
-- Name: COLUMN character_achievement.progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_achievement.progress IS '数值进度';


--
-- Name: COLUMN character_achievement.progress_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_achievement.progress_data IS '扩展进度（multi）';


--
-- Name: character_achievement_battle_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_achievement_battle_state (
    character_id integer NOT NULL,
    current_win_streak integer DEFAULT 0 NOT NULL,
    last_processed_battle_id character varying(128),
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_achievement_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_achievement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_achievement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_achievement_id_seq OWNED BY public.character_achievement.id;


--
-- Name: character_achievement_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_achievement_points (
    character_id integer NOT NULL,
    total_points integer DEFAULT 0 NOT NULL,
    combat_points integer DEFAULT 0 NOT NULL,
    cultivation_points integer DEFAULT 0 NOT NULL,
    exploration_points integer DEFAULT 0 NOT NULL,
    social_points integer DEFAULT 0 NOT NULL,
    collection_points integer DEFAULT 0 NOT NULL,
    claimed_thresholds jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_achievement_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_achievement_points IS '角色成就点数统计表';


--
-- Name: COLUMN character_achievement_points.claimed_thresholds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_achievement_points.claimed_thresholds IS '已领取点数阈值';


--
-- Name: character_feature_unlocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_feature_unlocks (
    id integer NOT NULL,
    character_id integer NOT NULL,
    feature_code character varying(64) NOT NULL,
    obtained_from character varying(64) NOT NULL,
    obtained_ref_id character varying(64) DEFAULT NULL::character varying,
    unlocked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_feature_unlocks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_feature_unlocks IS '角色功能解锁表';


--
-- Name: COLUMN character_feature_unlocks.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_feature_unlocks.character_id IS '角色ID';


--
-- Name: COLUMN character_feature_unlocks.feature_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_feature_unlocks.feature_code IS '功能编码';


--
-- Name: COLUMN character_feature_unlocks.obtained_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_feature_unlocks.obtained_from IS '解锁来源';


--
-- Name: COLUMN character_feature_unlocks.obtained_ref_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_feature_unlocks.obtained_ref_id IS '来源引用ID';


--
-- Name: COLUMN character_feature_unlocks.unlocked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_feature_unlocks.unlocked_at IS '解锁时间';


--
-- Name: character_feature_unlocks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_feature_unlocks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_feature_unlocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_feature_unlocks_id_seq OWNED BY public.character_feature_unlocks.id;


--
-- Name: character_global_buff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_global_buff (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    buff_key character varying(64) NOT NULL,
    source_type character varying(64) NOT NULL,
    source_id character varying(128) DEFAULT ''::character varying NOT NULL,
    buff_value numeric(12,3) DEFAULT 0 NOT NULL,
    grant_day_key date,
    started_at timestamp(6) with time zone NOT NULL,
    expire_at timestamp(6) with time zone NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_global_buff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_global_buff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_global_buff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_global_buff_id_seq OWNED BY public.character_global_buff.id;


--
-- Name: character_insight_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_insight_progress (
    character_id integer NOT NULL,
    level bigint DEFAULT 0 NOT NULL,
    total_exp_spent bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    progress_exp bigint DEFAULT 0 NOT NULL
);


--
-- Name: TABLE character_insight_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_insight_progress IS '角色悟道进度表（经验长期消耗系统）';


--
-- Name: COLUMN character_insight_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.character_id IS '角色ID（唯一）';


--
-- Name: COLUMN character_insight_progress.level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.level IS '悟道等级（无上限）';


--
-- Name: COLUMN character_insight_progress.total_exp_spent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.total_exp_spent IS '累计消耗经验';


--
-- Name: COLUMN character_insight_progress.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.created_at IS '创建时间';


--
-- Name: COLUMN character_insight_progress.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.updated_at IS '更新时间';


--
-- Name: COLUMN character_insight_progress.progress_exp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_insight_progress.progress_exp IS '当前等级内已注入经验（达到下一等级消耗时自动升到下一级）';


--
-- Name: character_item_grant_mail_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_item_grant_mail_outbox (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    recipient_user_id bigint NOT NULL,
    recipient_character_id bigint CONSTRAINT character_item_grant_mail_outbo_recipient_character_id_not_null NOT NULL,
    title character varying(128) NOT NULL,
    content text NOT NULL,
    attach_items jsonb NOT NULL,
    idle_session_ids jsonb,
    expire_days integer DEFAULT 30 NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sent_mail_id bigint,
    sent_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_item_grant_mail_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_item_grant_mail_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_item_grant_mail_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_item_grant_mail_outbox_id_seq OWNED BY public.character_item_grant_mail_outbox.id;


--
-- Name: character_main_quest_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_main_quest_progress (
    character_id integer NOT NULL,
    current_chapter_id character varying(64),
    current_section_id character varying(64),
    section_status character varying(16) DEFAULT 'not_started'::character varying,
    objectives_progress jsonb DEFAULT '{}'::jsonb,
    dialogue_state jsonb DEFAULT '{}'::jsonb,
    completed_chapters jsonb DEFAULT '[]'::jsonb,
    completed_sections jsonb DEFAULT '[]'::jsonb,
    tracked boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE character_main_quest_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_main_quest_progress IS '角色主线进度表';


--
-- Name: COLUMN character_main_quest_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.character_id IS '角色ID';


--
-- Name: COLUMN character_main_quest_progress.current_chapter_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.current_chapter_id IS '当前章节ID（静态配置ID）';


--
-- Name: COLUMN character_main_quest_progress.current_section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.current_section_id IS '当前任务节ID（静态配置ID）';


--
-- Name: COLUMN character_main_quest_progress.section_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.section_status IS '节状态：not_started/dialogue/objectives/turnin/completed';


--
-- Name: COLUMN character_main_quest_progress.objectives_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.objectives_progress IS '目标进度';


--
-- Name: COLUMN character_main_quest_progress.dialogue_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.dialogue_state IS '对话状态';


--
-- Name: COLUMN character_main_quest_progress.completed_chapters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.completed_chapters IS '已完成章节列表';


--
-- Name: COLUMN character_main_quest_progress.completed_sections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.completed_sections IS '已完成任务节列表';


--
-- Name: COLUMN character_main_quest_progress.tracked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_main_quest_progress.tracked IS '是否追踪主线任务';


--
-- Name: character_partner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_partner (
    id integer NOT NULL,
    character_id integer NOT NULL,
    partner_def_id character varying(64) NOT NULL,
    nickname character varying(64) NOT NULL,
    level bigint DEFAULT 1 NOT NULL,
    progress_exp bigint DEFAULT 0 NOT NULL,
    growth_max_qixue integer NOT NULL,
    growth_wugong integer NOT NULL,
    growth_fagong integer NOT NULL,
    growth_wufang integer NOT NULL,
    growth_fafang integer NOT NULL,
    growth_sudu integer NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    obtained_from character varying(64) NOT NULL,
    obtained_ref_id character varying(64) DEFAULT NULL::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar character varying(255),
    description character varying(80)
);


--
-- Name: TABLE character_partner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_partner IS '角色伙伴实例表';


--
-- Name: COLUMN character_partner.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.character_id IS '角色ID';


--
-- Name: COLUMN character_partner.partner_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.partner_def_id IS '伙伴模板ID';


--
-- Name: COLUMN character_partner.nickname; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.nickname IS '伙伴昵称';


--
-- Name: COLUMN character_partner.level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.level IS '伙伴等级（无上限）';


--
-- Name: COLUMN character_partner.progress_exp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.progress_exp IS '当前等级内进度经验';


--
-- Name: COLUMN character_partner.growth_max_qixue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_max_qixue IS '气血成长值';


--
-- Name: COLUMN character_partner.growth_wugong; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_wugong IS '物攻成长值';


--
-- Name: COLUMN character_partner.growth_fagong; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_fagong IS '法攻成长值';


--
-- Name: COLUMN character_partner.growth_wufang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_wufang IS '物防成长值';


--
-- Name: COLUMN character_partner.growth_fafang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_fafang IS '法防成长值';


--
-- Name: COLUMN character_partner.growth_sudu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.growth_sudu IS '速度成长值';


--
-- Name: COLUMN character_partner.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.is_active IS '是否当前出战';


--
-- Name: COLUMN character_partner.obtained_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.obtained_from IS '获得来源';


--
-- Name: COLUMN character_partner.obtained_ref_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner.obtained_ref_id IS '来源引用ID';


--
-- Name: character_partner_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_partner_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_partner_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_partner_id_seq OWNED BY public.character_partner.id;


--
-- Name: character_partner_skill_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_partner_skill_policy (
    id integer NOT NULL,
    partner_id integer NOT NULL,
    skill_id character varying(64) NOT NULL,
    priority integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_partner_skill_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_partner_skill_policy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_partner_skill_policy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_partner_skill_policy_id_seq OWNED BY public.character_partner_skill_policy.id;


--
-- Name: character_partner_technique; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_partner_technique (
    id integer NOT NULL,
    partner_id integer NOT NULL,
    technique_id character varying(64) NOT NULL,
    current_layer integer DEFAULT 1 NOT NULL,
    is_innate boolean DEFAULT false NOT NULL,
    learned_from_item_def_id character varying(64) DEFAULT NULL::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_partner_technique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_partner_technique IS '伙伴已学功法表';


--
-- Name: COLUMN character_partner_technique.partner_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner_technique.partner_id IS '伙伴实例ID';


--
-- Name: COLUMN character_partner_technique.technique_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner_technique.technique_id IS '伙伴功法ID';


--
-- Name: COLUMN character_partner_technique.current_layer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner_technique.current_layer IS '伙伴功法当前层数';


--
-- Name: COLUMN character_partner_technique.is_innate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner_technique.is_innate IS '是否天生功法';


--
-- Name: COLUMN character_partner_technique.learned_from_item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_partner_technique.learned_from_item_def_id IS '学习来源物品定义ID';


--
-- Name: character_partner_technique_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_partner_technique_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_partner_technique_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_partner_technique_id_seq OWNED BY public.character_partner_technique.id;


--
-- Name: character_rank_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_rank_snapshot (
    character_id integer NOT NULL,
    nickname character varying(50) DEFAULT ''::character varying NOT NULL,
    realm character varying(64) DEFAULT '凡人'::character varying NOT NULL,
    realm_rank integer DEFAULT 0 NOT NULL,
    power bigint DEFAULT 0 NOT NULL,
    wugong bigint DEFAULT 0 NOT NULL,
    fagong bigint DEFAULT 0 NOT NULL,
    wufang bigint DEFAULT 0 NOT NULL,
    fafang bigint DEFAULT 0 NOT NULL,
    max_qixue bigint DEFAULT 0 NOT NULL,
    max_lingqi bigint DEFAULT 0 NOT NULL,
    sudu bigint DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_research_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_research_points (
    character_id integer NOT NULL,
    balance_points integer DEFAULT 0 NOT NULL,
    total_earned_points bigint DEFAULT 0 NOT NULL,
    total_spent_points bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_research_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_research_points IS '历史研修点余额表（已停用）';


--
-- Name: COLUMN character_research_points.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_research_points.character_id IS '角色ID';


--
-- Name: COLUMN character_research_points.balance_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_research_points.balance_points IS '历史研修点余额';


--
-- Name: COLUMN character_research_points.total_earned_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_research_points.total_earned_points IS '历史累计获得研修点';


--
-- Name: COLUMN character_research_points.total_spent_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_research_points.total_spent_points IS '历史累计消耗研修点';


--
-- Name: character_room_resource_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_room_resource_state (
    id integer NOT NULL,
    character_id integer NOT NULL,
    map_id character varying(64) NOT NULL,
    room_id character varying(64) NOT NULL,
    resource_id character varying(64) NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    gather_until timestamp with time zone,
    cooldown_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_room_resource_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_room_resource_state IS '角色房间资源采集状态';


--
-- Name: COLUMN character_room_resource_state.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.id IS '主键ID';


--
-- Name: COLUMN character_room_resource_state.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.character_id IS '角色ID';


--
-- Name: COLUMN character_room_resource_state.map_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.map_id IS '地图ID';


--
-- Name: COLUMN character_room_resource_state.room_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.room_id IS '房间ID';


--
-- Name: COLUMN character_room_resource_state.resource_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.resource_id IS '资源ID（对应物品定义ID）';


--
-- Name: COLUMN character_room_resource_state.used_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.used_count IS '当前刷新周期已采集次数';


--
-- Name: COLUMN character_room_resource_state.gather_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.gather_until IS '采集中完成时间点（5秒一次）';


--
-- Name: COLUMN character_room_resource_state.cooldown_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.cooldown_until IS '耗尽后刷新时间点';


--
-- Name: COLUMN character_room_resource_state.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.created_at IS '创建时间';


--
-- Name: COLUMN character_room_resource_state.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_room_resource_state.updated_at IS '更新时间';


--
-- Name: character_room_resource_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_room_resource_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_room_resource_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_room_resource_state_id_seq OWNED BY public.character_room_resource_state.id;


--
-- Name: character_skill_slot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_skill_slot (
    id integer NOT NULL,
    character_id integer NOT NULL,
    slot_index integer NOT NULL,
    skill_id character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE character_skill_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_skill_slot IS '角色技能槽表';


--
-- Name: COLUMN character_skill_slot.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_skill_slot.character_id IS '角色ID';


--
-- Name: COLUMN character_skill_slot.slot_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_skill_slot.slot_index IS '技能槽位 1-10';


--
-- Name: COLUMN character_skill_slot.skill_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_skill_slot.skill_id IS '装配的技能ID（静态配置ID）';


--
-- Name: character_skill_slot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_skill_slot_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_skill_slot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_skill_slot_id_seq OWNED BY public.character_skill_slot.id;


--
-- Name: character_task_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_task_progress (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    task_id character varying(64) NOT NULL,
    status character varying(16) DEFAULT 'ongoing'::character varying NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    tracked boolean DEFAULT false NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    claimed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE character_task_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_task_progress IS '角色任务进度表';


--
-- Name: COLUMN character_task_progress.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.id IS '进度记录ID';


--
-- Name: COLUMN character_task_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.character_id IS '角色ID';


--
-- Name: COLUMN character_task_progress.task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.task_id IS '任务ID（静态或动态）';


--
-- Name: COLUMN character_task_progress.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.status IS '任务状态（ongoing进行中/claimable可领取/completed已完成/claimed已领取）';


--
-- Name: COLUMN character_task_progress.progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.progress IS '进度数据（JSON）';


--
-- Name: COLUMN character_task_progress.tracked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.tracked IS '是否追踪';


--
-- Name: COLUMN character_task_progress.accepted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.accepted_at IS '接取时间';


--
-- Name: COLUMN character_task_progress.completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.completed_at IS '完成时间';


--
-- Name: COLUMN character_task_progress.claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.claimed_at IS '领取时间';


--
-- Name: COLUMN character_task_progress.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_task_progress.updated_at IS '更新时间';


--
-- Name: character_task_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_task_progress_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_task_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_task_progress_id_seq OWNED BY public.character_task_progress.id;


--
-- Name: character_technique; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_technique (
    id integer NOT NULL,
    character_id integer NOT NULL,
    technique_id character varying(64) NOT NULL,
    current_layer integer DEFAULT 1,
    slot_type character varying(10),
    slot_index integer,
    obtained_from character varying(64),
    obtained_ref_id character varying(64),
    acquired_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE character_technique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_technique IS '角色功法表（动态数据）';


--
-- Name: COLUMN character_technique.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_technique.character_id IS '角色ID';


--
-- Name: COLUMN character_technique.technique_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_technique.technique_id IS '功法ID（静态配置ID）';


--
-- Name: COLUMN character_technique.current_layer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_technique.current_layer IS '当前修炼层数';


--
-- Name: COLUMN character_technique.slot_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_technique.slot_type IS '装备槽类型：main主功法/sub副功法/null未装备';


--
-- Name: COLUMN character_technique.slot_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_technique.slot_index IS '副功法槽位索引 1-3';


--
-- Name: character_technique_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_technique_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_technique_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_technique_id_seq OWNED BY public.character_technique.id;


--
-- Name: character_title; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_title (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    title_id character varying(64) NOT NULL,
    is_equipped boolean DEFAULT false NOT NULL,
    obtained_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: TABLE character_title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.character_title IS '角色称号拥有与装备状态';


--
-- Name: COLUMN character_title.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.character_title.expires_at IS '称号过期时间；NULL表示永久有效';


--
-- Name: character_title_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_title_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_title_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_title_id_seq OWNED BY public.character_title.id;


--
-- Name: character_tower_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_tower_progress (
    character_id integer NOT NULL,
    best_floor integer DEFAULT 0 NOT NULL,
    next_floor integer DEFAULT 1 NOT NULL,
    current_run_id character varying(64),
    current_floor integer,
    current_battle_id character varying(128),
    last_settled_floor integer DEFAULT 0 NOT NULL,
    reached_at timestamp(6) with time zone,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: character_wander_generation_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_wander_generation_job (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    day_key date NOT NULL,
    status character varying(32) NOT NULL,
    error_message text,
    generated_episode_id character varying(64),
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp(6) with time zone
);


--
-- Name: character_wander_story; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_wander_story (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    story_theme character varying(64) NOT NULL,
    story_premise character varying(200) NOT NULL,
    story_summary text NOT NULL,
    episode_count integer DEFAULT 0 NOT NULL,
    story_seed integer NOT NULL,
    reward_title_id character varying(64),
    finished_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    story_partner_snapshot jsonb,
    story_other_player_snapshot jsonb
);


--
-- Name: character_wander_story_episode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_wander_story_episode (
    id character varying(64) NOT NULL,
    story_id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    day_key date NOT NULL,
    day_index integer NOT NULL,
    episode_title character varying(128) NOT NULL,
    opening text NOT NULL,
    option_texts jsonb NOT NULL,
    chosen_option_index integer,
    chosen_option_text character varying(200),
    episode_summary text NOT NULL,
    is_ending boolean DEFAULT false NOT NULL,
    ending_type character varying(16) DEFAULT 'none'::character varying NOT NULL,
    reward_title_name character varying(32),
    reward_title_desc character varying(80),
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    chosen_at timestamp(6) with time zone,
    reward_title_color character varying(16),
    reward_title_effects jsonb,
    option_resolutions jsonb
);


--
-- Name: characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.characters (
    id integer NOT NULL,
    user_id integer NOT NULL,
    nickname character varying(50) NOT NULL,
    title character varying(50) DEFAULT '散修'::character varying,
    gender character varying(10) NOT NULL,
    avatar character varying(255) DEFAULT NULL::character varying,
    spirit_stones bigint DEFAULT 0,
    silver bigint DEFAULT 0,
    stamina integer DEFAULT 100 NOT NULL,
    realm character varying(50) DEFAULT '凡人'::character varying,
    sub_realm character varying(50) DEFAULT NULL::character varying,
    exp bigint DEFAULT 0,
    attribute_points integer DEFAULT 0,
    jing integer DEFAULT 0,
    qi integer DEFAULT 0,
    shen integer DEFAULT 0,
    attribute_type character varying(20) DEFAULT 'physical'::character varying,
    attribute_element character varying(10) DEFAULT 'none'::character varying,
    current_map_id character varying(64) DEFAULT 'map-qingyun-village'::character varying,
    current_room_id character varying(64) DEFAULT 'room-village-center'::character varying,
    auto_cast_skills boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    auto_disassemble_enabled boolean DEFAULT false,
    stamina_recover_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_disassemble_rules jsonb DEFAULT '[]'::jsonb,
    last_offline_at timestamp with time zone,
    dungeon_no_stamina_cost boolean DEFAULT false,
    partner_recruit_generated_non_heaven_count integer DEFAULT 0 NOT NULL,
    technique_research_generated_non_heaven_count integer DEFAULT 0 CONSTRAINT characters_technique_research_generated_non_heaven_cou_not_null NOT NULL
);


--
-- Name: TABLE characters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.characters IS '玩家角色表（可计算战斗属性不入库）';


--
-- Name: COLUMN characters.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.id IS '角色ID，自增主键';


--
-- Name: COLUMN characters.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.user_id IS '关联用户ID';


--
-- Name: COLUMN characters.nickname; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.nickname IS '昵称';


--
-- Name: COLUMN characters.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.title IS '称号';


--
-- Name: COLUMN characters.gender; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.gender IS '性别：male/female';


--
-- Name: COLUMN characters.avatar; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.avatar IS '头像路径';


--
-- Name: COLUMN characters.spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.spirit_stones IS '灵石';


--
-- Name: COLUMN characters.silver; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.silver IS '银两';


--
-- Name: COLUMN characters.stamina; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.stamina IS '体力';


--
-- Name: COLUMN characters.realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.realm IS '境界';


--
-- Name: COLUMN characters.sub_realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.sub_realm IS '子境界';


--
-- Name: COLUMN characters.exp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.exp IS '经验';


--
-- Name: COLUMN characters.attribute_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.attribute_points IS '可分配属性点';


--
-- Name: COLUMN characters.jing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.jing IS '精';


--
-- Name: COLUMN characters.qi; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.qi IS '气';


--
-- Name: COLUMN characters.shen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.shen IS '神';


--
-- Name: COLUMN characters.attribute_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.attribute_type IS '属性类型：physical物理/magic法术';


--
-- Name: COLUMN characters.attribute_element; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.attribute_element IS '五行属性：none/jin/mu/shui/huo/tu';


--
-- Name: COLUMN characters.current_map_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.current_map_id IS '当前所在地图ID';


--
-- Name: COLUMN characters.current_room_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.current_room_id IS '当前所在房间ID';


--
-- Name: COLUMN characters.auto_cast_skills; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.auto_cast_skills IS '自动释放技能开关';


--
-- Name: COLUMN characters.auto_disassemble_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.auto_disassemble_enabled IS '自动分解物品开关';


--
-- Name: COLUMN characters.stamina_recover_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.stamina_recover_at IS '体力恢复基准时间';


--
-- Name: COLUMN characters.auto_disassemble_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.auto_disassemble_rules IS '自动分解高级规则JSON数组（规则间 OR）';


--
-- Name: COLUMN characters.last_offline_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.characters.last_offline_at IS '最后离线时间';


--
-- Name: characters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.characters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: characters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.characters_id_seq OWNED BY public.characters.id;


--
-- Name: dungeon_entry_count; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dungeon_entry_count (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    dungeon_id character varying(64) NOT NULL,
    daily_count integer DEFAULT 0 NOT NULL,
    weekly_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    last_daily_reset date,
    last_weekly_reset date
);


--
-- Name: TABLE dungeon_entry_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dungeon_entry_count IS '副本秘境次数统计表';


--
-- Name: COLUMN dungeon_entry_count.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.id IS '主键';


--
-- Name: COLUMN dungeon_entry_count.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.character_id IS '角色ID';


--
-- Name: COLUMN dungeon_entry_count.dungeon_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.dungeon_id IS '秘境ID（静态配置ID）';


--
-- Name: COLUMN dungeon_entry_count.daily_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.daily_count IS '今日次数';


--
-- Name: COLUMN dungeon_entry_count.weekly_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.weekly_count IS '本周次数';


--
-- Name: COLUMN dungeon_entry_count.total_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.total_count IS '总次数';


--
-- Name: COLUMN dungeon_entry_count.last_daily_reset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.last_daily_reset IS '上次日重置日期';


--
-- Name: COLUMN dungeon_entry_count.last_weekly_reset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_entry_count.last_weekly_reset IS '上次周重置日期';


--
-- Name: dungeon_entry_count_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dungeon_entry_count_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dungeon_entry_count_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dungeon_entry_count_id_seq OWNED BY public.dungeon_entry_count.id;


--
-- Name: dungeon_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dungeon_instance (
    id character varying(64) NOT NULL,
    dungeon_id character varying(64) NOT NULL,
    difficulty_id character varying(64) NOT NULL,
    creator_id integer NOT NULL,
    team_id character varying(64),
    status character varying(32) DEFAULT 'preparing'::character varying NOT NULL,
    current_stage integer DEFAULT 1 NOT NULL,
    current_wave integer DEFAULT 1 NOT NULL,
    participants jsonb DEFAULT '[]'::jsonb NOT NULL,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    time_spent_sec integer DEFAULT 0 NOT NULL,
    total_damage bigint DEFAULT 0 NOT NULL,
    death_count integer DEFAULT 0 NOT NULL,
    rewards_claimed boolean DEFAULT false NOT NULL,
    instance_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dungeon_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dungeon_instance IS '副本秘境实例表';


--
-- Name: COLUMN dungeon_instance.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.id IS '实例ID';


--
-- Name: COLUMN dungeon_instance.dungeon_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.dungeon_id IS '秘境ID（静态配置ID）';


--
-- Name: COLUMN dungeon_instance.difficulty_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.difficulty_id IS '难度ID（静态配置ID）';


--
-- Name: COLUMN dungeon_instance.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.creator_id IS '创建者角色ID';


--
-- Name: COLUMN dungeon_instance.team_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.team_id IS '队伍ID';


--
-- Name: COLUMN dungeon_instance.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.status IS '状态（preparing/running/cleared/failed/abandoned）';


--
-- Name: COLUMN dungeon_instance.current_stage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.current_stage IS '当前关卡序号';


--
-- Name: COLUMN dungeon_instance.current_wave; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.current_wave IS '当前波次序号';


--
-- Name: COLUMN dungeon_instance.participants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.participants IS '参与者列表';


--
-- Name: COLUMN dungeon_instance.start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.start_time IS '开始时间';


--
-- Name: COLUMN dungeon_instance.end_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.end_time IS '结束时间';


--
-- Name: COLUMN dungeon_instance.time_spent_sec; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.time_spent_sec IS '耗时（秒）';


--
-- Name: COLUMN dungeon_instance.total_damage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.total_damage IS '总伤害';


--
-- Name: COLUMN dungeon_instance.death_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.death_count IS '死亡次数';


--
-- Name: COLUMN dungeon_instance.rewards_claimed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.rewards_claimed IS '是否已领取奖励';


--
-- Name: COLUMN dungeon_instance.instance_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.instance_data IS '实例数据（进度、状态等）';


--
-- Name: COLUMN dungeon_instance.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_instance.created_at IS '创建时间';


--
-- Name: dungeon_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dungeon_record (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    dungeon_id character varying(64) NOT NULL,
    difficulty_id character varying(64) NOT NULL,
    instance_id character varying(64),
    result character varying(32) NOT NULL,
    time_spent_sec integer DEFAULT 0 NOT NULL,
    damage_dealt bigint DEFAULT 0 NOT NULL,
    damage_taken bigint DEFAULT 0 NOT NULL,
    healing_done bigint DEFAULT 0 NOT NULL,
    death_count integer DEFAULT 0 NOT NULL,
    score character varying(1),
    rewards jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_first_clear boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dungeon_record; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dungeon_record IS '副本秘境通关记录表';


--
-- Name: COLUMN dungeon_record.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.id IS '记录ID';


--
-- Name: COLUMN dungeon_record.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.character_id IS '角色ID';


--
-- Name: COLUMN dungeon_record.dungeon_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.dungeon_id IS '秘境ID（静态配置ID）';


--
-- Name: COLUMN dungeon_record.difficulty_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.difficulty_id IS '难度ID（静态配置ID）';


--
-- Name: COLUMN dungeon_record.instance_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.instance_id IS '实例ID';


--
-- Name: COLUMN dungeon_record.result; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.result IS '结果（cleared/failed/abandoned）';


--
-- Name: COLUMN dungeon_record.time_spent_sec; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.time_spent_sec IS '耗时（秒）';


--
-- Name: COLUMN dungeon_record.damage_dealt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.damage_dealt IS '造成伤害';


--
-- Name: COLUMN dungeon_record.damage_taken; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.damage_taken IS '承受伤害';


--
-- Name: COLUMN dungeon_record.healing_done; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.healing_done IS '治疗量';


--
-- Name: COLUMN dungeon_record.death_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.death_count IS '死亡次数';


--
-- Name: COLUMN dungeon_record.score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.score IS '评分（S/A/B/C/D）';


--
-- Name: COLUMN dungeon_record.rewards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.rewards IS '获得奖励';


--
-- Name: COLUMN dungeon_record.is_first_clear; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.is_first_clear IS '是否首通';


--
-- Name: COLUMN dungeon_record.completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dungeon_record.completed_at IS '完成时间';


--
-- Name: dungeon_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dungeon_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dungeon_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dungeon_record_id_seq OWNED BY public.dungeon_record.id;


--
-- Name: game_time; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_time (
    id smallint NOT NULL,
    era_name character varying(32) NOT NULL,
    base_year integer NOT NULL,
    game_elapsed_ms bigint NOT NULL,
    weather character varying(16) NOT NULL,
    scale integer DEFAULT 60 NOT NULL,
    last_real_ms bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sect_maintenance_day_serial integer
);


--
-- Name: TABLE game_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.game_time IS '游戏时间状态表';


--
-- Name: COLUMN game_time.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.id IS '主键（固定为1）';


--
-- Name: COLUMN game_time.era_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.era_name IS '纪元名称';


--
-- Name: COLUMN game_time.base_year; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.base_year IS '起始年份';


--
-- Name: COLUMN game_time.game_elapsed_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.game_elapsed_ms IS '游戏时间累计毫秒（从起始日期00:00起算）';


--
-- Name: COLUMN game_time.weather; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.weather IS '天气';


--
-- Name: COLUMN game_time.scale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.scale IS '时间倍率（1真实秒对应的游戏秒数）';


--
-- Name: COLUMN game_time.last_real_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.last_real_ms IS '上次记录时的服务器真实时间戳毫秒';


--
-- Name: COLUMN game_time.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.game_time.updated_at IS '更新时间';


--
-- Name: generated_partner_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_partner_def (
    id character varying(64) NOT NULL,
    name character varying(64) NOT NULL,
    description text,
    avatar character varying(255),
    quality character varying(8) NOT NULL,
    attribute_element character varying(16) NOT NULL,
    role character varying(32) NOT NULL,
    max_technique_slots integer NOT NULL,
    base_attrs jsonb NOT NULL,
    level_attr_gains jsonb DEFAULT '{}'::jsonb NOT NULL,
    innate_technique_ids text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by_character_id integer NOT NULL,
    source_job_id character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE generated_partner_def; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.generated_partner_def IS 'AI 生成伙伴定义表';


--
-- Name: COLUMN generated_partner_def.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.id IS '动态伙伴定义ID';


--
-- Name: COLUMN generated_partner_def.base_attrs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.base_attrs IS '伙伴基础属性 JSON';


--
-- Name: COLUMN generated_partner_def.level_attr_gains; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.level_attr_gains IS '伙伴每级成长属性 JSON';


--
-- Name: COLUMN generated_partner_def.innate_technique_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.innate_technique_ids IS '伙伴天生功法ID列表';


--
-- Name: COLUMN generated_partner_def.created_by_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.created_by_character_id IS '创建该伙伴的角色ID';


--
-- Name: COLUMN generated_partner_def.source_job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_partner_def.source_job_id IS '来源招募任务ID';


--
-- Name: generated_skill_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_skill_def (
    id character varying(64) NOT NULL,
    generation_id character varying(64) NOT NULL,
    source_type character varying(16) NOT NULL,
    source_id character varying(64) NOT NULL,
    code character varying(64),
    name character varying(64) NOT NULL,
    description text,
    icon character varying(255),
    cost_lingqi integer DEFAULT 0 NOT NULL,
    cost_qixue integer DEFAULT 0 NOT NULL,
    cooldown integer DEFAULT 0 NOT NULL,
    target_type character varying(32) NOT NULL,
    target_count integer DEFAULT 1 NOT NULL,
    damage_type character varying(16),
    element character varying(16) DEFAULT 'none'::character varying NOT NULL,
    effects jsonb DEFAULT '[]'::jsonb NOT NULL,
    trigger_type character varying(16) DEFAULT 'active'::character varying NOT NULL,
    conditions jsonb,
    ai_priority integer DEFAULT 50 NOT NULL,
    ai_conditions jsonb,
    upgrades jsonb,
    sort_weight integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cost_lingqi_rate numeric(8,4) DEFAULT 0 NOT NULL,
    cost_qixue_rate numeric(8,4) DEFAULT 0 NOT NULL
);


--
-- Name: TABLE generated_skill_def; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.generated_skill_def IS 'AI生成功法技能定义';


--
-- Name: COLUMN generated_skill_def.cost_lingqi_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_skill_def.cost_lingqi_rate IS '按最大灵气比例消耗（0.1=10%）';


--
-- Name: COLUMN generated_skill_def.cost_qixue_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_skill_def.cost_qixue_rate IS '按最大气血比例消耗（0.1=10%）';


--
-- Name: generated_technique_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_technique_def (
    id character varying(64) NOT NULL,
    generation_id character varying(64) NOT NULL,
    created_by_character_id integer NOT NULL,
    name character varying(64) NOT NULL,
    display_name character varying(64),
    normalized_name character varying(64),
    type character varying(16) NOT NULL,
    quality character varying(4) NOT NULL,
    max_layer integer NOT NULL,
    required_realm character varying(64) NOT NULL,
    attribute_type character varying(16) NOT NULL,
    attribute_element character varying(16) NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    description text,
    long_desc text,
    icon character varying(255),
    is_published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    name_locked boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    usage_scope character varying(32) DEFAULT 'character_only'::character varying NOT NULL,
    custom_name character varying(64),
    identity_suffix character varying(16),
    normalized_custom_name character varying(64),
    model_name character varying(64)
);


--
-- Name: TABLE generated_technique_def; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.generated_technique_def IS 'AI生成功法定义（草稿+已发布）';


--
-- Name: COLUMN generated_technique_def.generation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.generation_id IS '生成功法任务ID';


--
-- Name: COLUMN generated_technique_def.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.display_name IS '玩家自定义展示名';


--
-- Name: COLUMN generated_technique_def.normalized_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.normalized_name IS '展示名规范化结果，用于唯一性比较';


--
-- Name: COLUMN generated_technique_def.is_published; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.is_published IS '是否已发布';


--
-- Name: COLUMN generated_technique_def.name_locked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.name_locked IS '名称是否锁定（首发后不可改）';


--
-- Name: COLUMN generated_technique_def.usage_scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.generated_technique_def.usage_scope IS '功法作用域：character_only / partner_only';


--
-- Name: generated_technique_layer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_technique_layer (
    id bigint NOT NULL,
    generation_id character varying(64) NOT NULL,
    technique_id character varying(64) NOT NULL,
    layer integer NOT NULL,
    cost_spirit_stones integer DEFAULT 0 NOT NULL,
    cost_exp integer DEFAULT 0 NOT NULL,
    cost_materials jsonb DEFAULT '[]'::jsonb NOT NULL,
    passives jsonb DEFAULT '[]'::jsonb NOT NULL,
    unlock_skill_ids text[] DEFAULT '{}'::text[] NOT NULL,
    upgrade_skill_ids text[] DEFAULT '{}'::text[] NOT NULL,
    required_realm character varying(64),
    required_quest_id character varying(64),
    layer_desc text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE generated_technique_layer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.generated_technique_layer IS 'AI生成功法层级定义';


--
-- Name: generated_technique_layer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generated_technique_layer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generated_technique_layer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generated_technique_layer_id_seq OWNED BY public.generated_technique_layer.id;


--
-- Name: generated_title_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_title_def (
    id character varying(64) NOT NULL,
    name character varying(32) NOT NULL,
    description character varying(80) NOT NULL,
    color character varying(16),
    icon character varying(255),
    effects jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_type character varying(32) NOT NULL,
    source_id character varying(64) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: idle_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idle_configs (
    character_id integer NOT NULL,
    map_id character varying(100),
    room_id character varying(100),
    max_duration_ms bigint DEFAULT 3600000 NOT NULL,
    auto_skill_policy jsonb DEFAULT '{"slots": []}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    target_monster_def_id character varying(100),
    include_partner_in_battle boolean DEFAULT true NOT NULL
);


--
-- Name: idle_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idle_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id integer NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    map_id character varying(100) NOT NULL,
    room_id character varying(100) NOT NULL,
    max_duration_ms bigint NOT NULL,
    session_snapshot jsonb NOT NULL,
    total_battles integer DEFAULT 0 NOT NULL,
    win_count integer DEFAULT 0 NOT NULL,
    lose_count integer DEFAULT 0 NOT NULL,
    total_exp integer DEFAULT 0 NOT NULL,
    total_silver integer DEFAULT 0 NOT NULL,
    bag_full_flag boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    viewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    bag_capacity integer DEFAULT 100 NOT NULL,
    warehouse_capacity integer DEFAULT 1000 NOT NULL,
    bag_expand_count integer DEFAULT 0 NOT NULL,
    warehouse_expand_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE inventory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inventory IS '背包元数据表';


--
-- Name: COLUMN inventory.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory.character_id IS '角色ID（一对一）';


--
-- Name: COLUMN inventory.bag_capacity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory.bag_capacity IS '背包格子数量';


--
-- Name: COLUMN inventory.warehouse_capacity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory.warehouse_capacity IS '仓库格子数量';


--
-- Name: COLUMN inventory.bag_expand_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory.bag_expand_count IS '背包扩容次数';


--
-- Name: COLUMN inventory.warehouse_expand_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inventory.warehouse_expand_count IS '仓库扩容次数';


--
-- Name: inventory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventory_id_seq OWNED BY public.inventory.id;


--
-- Name: item_instance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_instance (
    id bigint NOT NULL,
    owner_user_id bigint NOT NULL,
    owner_character_id bigint,
    item_def_id character varying(64) NOT NULL,
    qty integer DEFAULT 1 NOT NULL,
    quality character(1),
    quality_rank integer,
    bind_type character varying(16) DEFAULT 'none'::character varying NOT NULL,
    bind_owner_user_id bigint,
    bind_owner_character_id bigint,
    location character varying(16) DEFAULT 'bag'::character varying NOT NULL,
    location_slot integer,
    equipped_slot character varying(32),
    strengthen_level integer DEFAULT 0,
    refine_level integer DEFAULT 0,
    socketed_gems jsonb,
    random_seed bigint,
    affixes jsonb,
    identified boolean DEFAULT true NOT NULL,
    custom_name character varying(64),
    locked boolean DEFAULT false NOT NULL,
    expire_at timestamp with time zone,
    obtained_from character varying(128),
    obtained_ref_id character varying(64),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    affix_gen_version integer DEFAULT 1 NOT NULL,
    affix_roll_meta jsonb
);


--
-- Name: TABLE item_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_instance IS '物品实例表（动态数据）';


--
-- Name: COLUMN item_instance.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.id IS '物品实例ID';


--
-- Name: COLUMN item_instance.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.owner_user_id IS '拥有者用户ID';


--
-- Name: COLUMN item_instance.owner_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.owner_character_id IS '拥有者角色ID';


--
-- Name: COLUMN item_instance.item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.item_def_id IS '物品定义ID（静态配置ID）';


--
-- Name: COLUMN item_instance.qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.qty IS '数量（堆叠数量）';


--
-- Name: COLUMN item_instance.quality; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.quality IS '实例品质（为空则按定义表）';


--
-- Name: COLUMN item_instance.quality_rank; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.quality_rank IS '实例品质排序值（为空则按定义表）';


--
-- Name: COLUMN item_instance.location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.location IS '位置（bag/warehouse/equipped/mail/auction）';


--
-- Name: COLUMN item_instance.location_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.location_slot IS '位置格子（从0开始）';


--
-- Name: COLUMN item_instance.equipped_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.equipped_slot IS '装备槽位（已装备时记录）';


--
-- Name: COLUMN item_instance.strengthen_level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.strengthen_level IS '强化等级';


--
-- Name: COLUMN item_instance.affixes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.affixes IS '随机词条结果（JSONB）';


--
-- Name: COLUMN item_instance.identified; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.identified IS '是否已鉴定';


--
-- Name: COLUMN item_instance.locked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.locked IS '是否锁定（防误操作）';


--
-- Name: COLUMN item_instance.obtained_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.obtained_from IS '获取来源类型';


--
-- Name: COLUMN item_instance.affix_gen_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.affix_gen_version IS '词条生成版本号（用于规则升级）';


--
-- Name: COLUMN item_instance.affix_roll_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_instance.affix_roll_meta IS '词条生成元信息（预算/参数快照）';


--
-- Name: item_instance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_instance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_instance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_instance_id_seq OWNED BY public.item_instance.id;


--
-- Name: item_use_cooldown; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_use_cooldown (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    item_def_id character varying(64) NOT NULL,
    cooldown_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE item_use_cooldown; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_use_cooldown IS '物品使用冷却表';


--
-- Name: COLUMN item_use_cooldown.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_cooldown.character_id IS '角色ID';


--
-- Name: COLUMN item_use_cooldown.item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_cooldown.item_def_id IS '物品定义ID（静态配置ID）';


--
-- Name: COLUMN item_use_cooldown.cooldown_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_cooldown.cooldown_until IS '冷却结束时间';


--
-- Name: item_use_cooldown_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_use_cooldown_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_use_cooldown_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_use_cooldown_id_seq OWNED BY public.item_use_cooldown.id;


--
-- Name: item_use_count; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_use_count (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    item_def_id character varying(64) NOT NULL,
    daily_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    last_daily_reset date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE item_use_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_use_count IS '物品使用次数表';


--
-- Name: COLUMN item_use_count.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_count.character_id IS '角色ID';


--
-- Name: COLUMN item_use_count.item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_count.item_def_id IS '物品定义ID（静态配置ID）';


--
-- Name: COLUMN item_use_count.daily_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_count.daily_count IS '当日使用次数';


--
-- Name: COLUMN item_use_count.total_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_count.total_count IS '累计使用次数';


--
-- Name: COLUMN item_use_count.last_daily_reset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_use_count.last_daily_reset IS '最后一次日重置日期';


--
-- Name: item_use_count_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_use_count_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_use_count_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_use_count_id_seq OWNED BY public.item_use_count.id;


--
-- Name: mail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail (
    id bigint NOT NULL,
    recipient_user_id bigint NOT NULL,
    recipient_character_id bigint,
    sender_type character varying(16) DEFAULT 'system'::character varying NOT NULL,
    sender_user_id bigint,
    sender_character_id bigint,
    sender_name character varying(64) DEFAULT '系统'::character varying NOT NULL,
    mail_type character varying(32) DEFAULT 'normal'::character varying NOT NULL,
    title character varying(128) NOT NULL,
    content text NOT NULL,
    attach_silver integer DEFAULT 0 NOT NULL,
    attach_spirit_stones integer DEFAULT 0 NOT NULL,
    attach_items jsonb,
    attach_instance_ids jsonb,
    read_at timestamp with time zone,
    claimed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    expire_at timestamp with time zone,
    source character varying(64),
    source_ref_id character varying(64),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attach_rewards jsonb
);


--
-- Name: TABLE mail; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mail IS '邮件表';


--
-- Name: COLUMN mail.recipient_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.recipient_user_id IS '收件人用户ID';


--
-- Name: COLUMN mail.recipient_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.recipient_character_id IS '收件人角色ID（正整数）';


--
-- Name: COLUMN mail.sender_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.sender_type IS '发件人类型（system/player/gm）';


--
-- Name: COLUMN mail.sender_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.sender_name IS '发件人显示名称';


--
-- Name: COLUMN mail.mail_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.mail_type IS '邮件类型（normal/reward/trade/gm）';


--
-- Name: COLUMN mail.attach_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.attach_items IS '附件物品列表（物品定义）';


--
-- Name: COLUMN mail.attach_instance_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.attach_instance_ids IS '已生成的物品实例ID（领取后填充）';


--
-- Name: COLUMN mail.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.read_at IS '阅读时间';


--
-- Name: COLUMN mail.claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.claimed_at IS '领取附件时间';


--
-- Name: COLUMN mail.deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.deleted_at IS '删除时间（软删除）';


--
-- Name: COLUMN mail.expire_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mail.expire_at IS '过期时间';


--
-- Name: mail_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_counter (
    scope_type character varying(16) NOT NULL,
    scope_id bigint NOT NULL,
    total_count bigint DEFAULT 0 NOT NULL,
    unread_count bigint DEFAULT 0 NOT NULL,
    unclaimed_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: mail_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mail_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mail_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mail_id_seq OWNED BY public.mail.id;


--
-- Name: market_listing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_listing (
    id bigint NOT NULL,
    seller_user_id integer NOT NULL,
    seller_character_id integer NOT NULL,
    item_instance_id bigint,
    item_def_id character varying(64) NOT NULL,
    qty integer NOT NULL,
    unit_price_spirit_stones bigint NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    buyer_user_id integer,
    buyer_character_id integer,
    listed_at timestamp with time zone DEFAULT now() NOT NULL,
    sold_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    listing_fee_silver bigint DEFAULT 0 NOT NULL,
    original_qty integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE market_listing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.market_listing IS '坊市上架表';


--
-- Name: COLUMN market_listing.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.id IS '上架ID';


--
-- Name: COLUMN market_listing.seller_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.seller_user_id IS '卖家用户ID';


--
-- Name: COLUMN market_listing.seller_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.seller_character_id IS '卖家角色ID';


--
-- Name: COLUMN market_listing.item_instance_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.item_instance_id IS '上架物品实例ID';


--
-- Name: COLUMN market_listing.item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.item_def_id IS '物品定义ID';


--
-- Name: COLUMN market_listing.qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.qty IS '上架数量';


--
-- Name: COLUMN market_listing.unit_price_spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.unit_price_spirit_stones IS '单价（灵石）';


--
-- Name: COLUMN market_listing.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.status IS '状态（active/sold/cancelled）';


--
-- Name: COLUMN market_listing.buyer_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.buyer_user_id IS '买家用户ID';


--
-- Name: COLUMN market_listing.buyer_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.buyer_character_id IS '买家角色ID';


--
-- Name: COLUMN market_listing.listed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.listed_at IS '上架时间';


--
-- Name: COLUMN market_listing.sold_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.sold_at IS '售出时间';


--
-- Name: COLUMN market_listing.cancelled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.cancelled_at IS '下架时间';


--
-- Name: COLUMN market_listing.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.updated_at IS '更新时间';


--
-- Name: COLUMN market_listing.listing_fee_silver; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_listing.listing_fee_silver IS '上架手续费（银两）';


--
-- Name: market_listing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.market_listing_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: market_listing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.market_listing_id_seq OWNED BY public.market_listing.id;


--
-- Name: market_partner_listing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_partner_listing (
    id bigint NOT NULL,
    seller_user_id integer NOT NULL,
    seller_character_id integer NOT NULL,
    partner_id integer NOT NULL,
    partner_snapshot jsonb NOT NULL,
    partner_def_id character varying(64) NOT NULL,
    partner_name character varying(64) NOT NULL,
    partner_nickname character varying(64) NOT NULL,
    partner_quality character varying(8) NOT NULL,
    partner_element character varying(16) NOT NULL,
    partner_level integer NOT NULL,
    unit_price_spirit_stones bigint NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    buyer_user_id integer,
    buyer_character_id integer,
    listed_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sold_at timestamp(6) with time zone,
    cancelled_at timestamp(6) with time zone,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    listing_fee_silver bigint DEFAULT 0 NOT NULL
);


--
-- Name: market_partner_listing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.market_partner_listing_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: market_partner_listing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.market_partner_listing_id_seq OWNED BY public.market_partner_listing.id;


--
-- Name: market_partner_trade_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_partner_trade_record (
    id bigint NOT NULL,
    listing_id bigint,
    buyer_user_id integer NOT NULL,
    buyer_character_id integer NOT NULL,
    seller_user_id integer NOT NULL,
    seller_character_id integer NOT NULL,
    partner_id integer NOT NULL,
    partner_def_id character varying(64) NOT NULL,
    partner_snapshot jsonb NOT NULL,
    unit_price_spirit_stones bigint NOT NULL,
    total_price_spirit_stones bigint NOT NULL,
    tax_spirit_stones bigint DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: market_partner_trade_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.market_partner_trade_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: market_partner_trade_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.market_partner_trade_record_id_seq OWNED BY public.market_partner_trade_record.id;


--
-- Name: market_trade_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_trade_record (
    id bigint NOT NULL,
    listing_id bigint,
    buyer_user_id integer NOT NULL,
    buyer_character_id integer NOT NULL,
    seller_user_id integer NOT NULL,
    seller_character_id integer NOT NULL,
    item_def_id character varying(64) NOT NULL,
    qty integer NOT NULL,
    unit_price_spirit_stones bigint NOT NULL,
    total_price_spirit_stones bigint NOT NULL,
    tax_spirit_stones bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE market_trade_record; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.market_trade_record IS '坊市交易记录表';


--
-- Name: COLUMN market_trade_record.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.id IS '交易记录ID';


--
-- Name: COLUMN market_trade_record.listing_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.listing_id IS '上架ID';


--
-- Name: COLUMN market_trade_record.buyer_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.buyer_user_id IS '买家用户ID';


--
-- Name: COLUMN market_trade_record.buyer_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.buyer_character_id IS '买家角色ID';


--
-- Name: COLUMN market_trade_record.seller_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.seller_user_id IS '卖家用户ID';


--
-- Name: COLUMN market_trade_record.seller_character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.seller_character_id IS '卖家角色ID';


--
-- Name: COLUMN market_trade_record.item_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.item_def_id IS '物品定义ID';


--
-- Name: COLUMN market_trade_record.qty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.qty IS '成交数量';


--
-- Name: COLUMN market_trade_record.unit_price_spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.unit_price_spirit_stones IS '成交单价（灵石）';


--
-- Name: COLUMN market_trade_record.total_price_spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.total_price_spirit_stones IS '成交总价（灵石）';


--
-- Name: COLUMN market_trade_record.tax_spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.tax_spirit_stones IS '税费（灵石）';


--
-- Name: COLUMN market_trade_record.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_trade_record.created_at IS '成交时间';


--
-- Name: market_trade_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.market_trade_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: market_trade_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.market_trade_record_id_seq OWNED BY public.market_trade_record.id;


--
-- Name: month_card_claim_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.month_card_claim_record (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    month_card_id character varying(64) NOT NULL,
    claim_date date NOT NULL,
    reward_spirit_stones integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE month_card_claim_record; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.month_card_claim_record IS '月卡每日领取记录表';


--
-- Name: COLUMN month_card_claim_record.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.id IS '领取记录ID';


--
-- Name: COLUMN month_card_claim_record.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.character_id IS '角色ID';


--
-- Name: COLUMN month_card_claim_record.month_card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.month_card_id IS '月卡ID';


--
-- Name: COLUMN month_card_claim_record.claim_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.claim_date IS '领取日期';


--
-- Name: COLUMN month_card_claim_record.reward_spirit_stones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.reward_spirit_stones IS '领取灵石数量';


--
-- Name: COLUMN month_card_claim_record.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_claim_record.created_at IS '创建时间';


--
-- Name: month_card_claim_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.month_card_claim_record_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: month_card_claim_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.month_card_claim_record_id_seq OWNED BY public.month_card_claim_record.id;


--
-- Name: month_card_ownership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.month_card_ownership (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    month_card_id character varying(64) NOT NULL,
    start_at timestamp with time zone DEFAULT now() NOT NULL,
    expire_at timestamp with time zone NOT NULL,
    last_claim_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE month_card_ownership; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.month_card_ownership IS '角色月卡持有表';


--
-- Name: COLUMN month_card_ownership.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.id IS '持有记录ID';


--
-- Name: COLUMN month_card_ownership.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.character_id IS '角色ID';


--
-- Name: COLUMN month_card_ownership.month_card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.month_card_id IS '月卡ID';


--
-- Name: COLUMN month_card_ownership.start_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.start_at IS '开始时间';


--
-- Name: COLUMN month_card_ownership.expire_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.expire_at IS '到期时间';


--
-- Name: COLUMN month_card_ownership.last_claim_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.last_claim_date IS '最后领取日期';


--
-- Name: COLUMN month_card_ownership.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.created_at IS '创建时间';


--
-- Name: COLUMN month_card_ownership.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.month_card_ownership.updated_at IS '更新时间';


--
-- Name: month_card_ownership_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.month_card_ownership_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: month_card_ownership_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.month_card_ownership_id_seq OWNED BY public.month_card_ownership.id;


--
-- Name: online_battle_settlement_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.online_battle_settlement_task (
    id character varying(128) NOT NULL,
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


--
-- Name: partner_fusion_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_fusion_job (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    status character varying(32) NOT NULL,
    source_quality character varying(8) NOT NULL,
    result_quality character varying(8),
    preview_partner_def_id character varying(64),
    error_message text,
    viewed_at timestamp(6) with time zone,
    finished_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: partner_fusion_job_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_fusion_job_material (
    id bigint NOT NULL,
    fusion_job_id character varying(64) NOT NULL,
    partner_id integer NOT NULL,
    character_id integer NOT NULL,
    material_order integer NOT NULL,
    partner_snapshot jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: partner_fusion_job_material_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.partner_fusion_job_material_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: partner_fusion_job_material_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.partner_fusion_job_material_id_seq OWNED BY public.partner_fusion_job_material.id;


--
-- Name: partner_rank_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_rank_snapshot (
    partner_id integer NOT NULL,
    character_id integer NOT NULL,
    partner_name character varying(64) DEFAULT ''::character varying NOT NULL,
    avatar character varying(255),
    quality character varying(8) DEFAULT '黄'::character varying NOT NULL,
    element character varying(16) DEFAULT 'none'::character varying NOT NULL,
    role character varying(32) DEFAULT '伙伴'::character varying NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    power bigint DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: partner_rebone_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_rebone_job (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    partner_id integer NOT NULL,
    status character varying(32) NOT NULL,
    item_def_id character varying(64) NOT NULL,
    item_qty integer DEFAULT 1 NOT NULL,
    error_message text,
    viewed_at timestamp(6) with time zone,
    finished_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: partner_recruit_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_recruit_job (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    status character varying(32) NOT NULL,
    quality_rolled character varying(8) NOT NULL,
    spirit_stones_cost bigint NOT NULL,
    cooldown_started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    viewed_at timestamp with time zone,
    error_message text,
    preview_partner_def_id character varying(64),
    preview_avatar_url character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_base_model character varying(32),
    used_custom_base_model_token boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE partner_recruit_job; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.partner_recruit_job IS 'AI 伙伴招募任务表';


--
-- Name: COLUMN partner_recruit_job.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.id IS '招募任务ID';


--
-- Name: COLUMN partner_recruit_job.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.status IS '任务状态：pending/generated_draft/accepted/failed/refunded/discarded';


--
-- Name: COLUMN partner_recruit_job.quality_rolled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.quality_rolled IS '本次招募抽取到的伙伴品质';


--
-- Name: COLUMN partner_recruit_job.spirit_stones_cost; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.spirit_stones_cost IS '本次招募消耗灵石';


--
-- Name: COLUMN partner_recruit_job.cooldown_started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.cooldown_started_at IS '冷却开始时间';


--
-- Name: COLUMN partner_recruit_job.finished_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.finished_at IS '任务结束时间';


--
-- Name: COLUMN partner_recruit_job.viewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.viewed_at IS '结果首次被玩家查看时间';


--
-- Name: COLUMN partner_recruit_job.preview_partner_def_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.partner_recruit_job.preview_partner_def_id IS '生成成功后的预览伙伴定义ID';


--
-- Name: redeem_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redeem_code (
    id bigint NOT NULL,
    code character varying(32) NOT NULL,
    source_type character varying(32) NOT NULL,
    source_ref_id character varying(64) NOT NULL,
    reward_payload jsonb NOT NULL,
    status character varying(16) DEFAULT 'created'::character varying NOT NULL,
    redeemed_by_user_id integer,
    redeemed_by_character_id integer,
    redeemed_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: redeem_code_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.redeem_code_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: redeem_code_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.redeem_code_id_seq OWNED BY public.redeem_code.id;


--
-- Name: research_points_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_points_ledger (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    change_points integer NOT NULL,
    reason character varying(32) NOT NULL,
    ref_type character varying(32),
    ref_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE research_points_ledger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.research_points_ledger IS '历史研修点流水（已停用）';


--
-- Name: COLUMN research_points_ledger.change_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.research_points_ledger.change_points IS '历史变化值（正负）';


--
-- Name: COLUMN research_points_ledger.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.research_points_ledger.reason IS '历史流水原因';


--
-- Name: research_points_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_points_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_points_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_points_ledger_id_seq OWNED BY public.research_points_ledger.id;


--
-- Name: sect_application; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_application (
    id bigint NOT NULL,
    sect_id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    message text,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    handled_at timestamp with time zone,
    handled_by integer
);


--
-- Name: TABLE sect_application; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_application IS '宗门申请表';


--
-- Name: COLUMN sect_application.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.id IS '申请记录ID';


--
-- Name: COLUMN sect_application.sect_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.sect_id IS '宗门ID';


--
-- Name: COLUMN sect_application.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.character_id IS '申请角色ID';


--
-- Name: COLUMN sect_application.message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.message IS '申请留言';


--
-- Name: COLUMN sect_application.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.status IS '申请状态（pending/approved/rejected/cancelled）';


--
-- Name: COLUMN sect_application.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.created_at IS '申请时间';


--
-- Name: COLUMN sect_application.handled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.handled_at IS '处理时间';


--
-- Name: COLUMN sect_application.handled_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_application.handled_by IS '处理人角色ID';


--
-- Name: sect_application_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sect_application_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sect_application_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sect_application_id_seq OWNED BY public.sect_application.id;


--
-- Name: sect_building; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_building (
    id bigint NOT NULL,
    sect_id character varying(64) NOT NULL,
    building_type character varying(64) NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    status character varying(32) DEFAULT 'normal'::character varying NOT NULL,
    upgrade_start_at timestamp with time zone,
    upgrade_end_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sect_building; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_building IS '宗门建筑表';


--
-- Name: COLUMN sect_building.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.id IS '建筑记录ID';


--
-- Name: COLUMN sect_building.sect_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.sect_id IS '宗门ID';


--
-- Name: COLUMN sect_building.building_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.building_type IS '建筑类型';


--
-- Name: COLUMN sect_building.level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.level IS '建筑等级';


--
-- Name: COLUMN sect_building.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.status IS '建筑状态';


--
-- Name: COLUMN sect_building.upgrade_start_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.upgrade_start_at IS '升级开始时间';


--
-- Name: COLUMN sect_building.upgrade_end_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.upgrade_end_at IS '升级结束时间';


--
-- Name: COLUMN sect_building.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.created_at IS '创建时间';


--
-- Name: COLUMN sect_building.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_building.updated_at IS '更新时间';


--
-- Name: sect_building_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sect_building_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sect_building_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sect_building_id_seq OWNED BY public.sect_building.id;


--
-- Name: sect_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_def (
    id character varying(64) NOT NULL,
    name character varying(64) NOT NULL,
    leader_id integer NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    exp bigint DEFAULT 0 NOT NULL,
    funds bigint DEFAULT 0 NOT NULL,
    reputation bigint DEFAULT 0 NOT NULL,
    build_points integer DEFAULT 0 NOT NULL,
    announcement text,
    description text,
    icon character varying(256),
    join_type character varying(32) DEFAULT 'apply'::character varying NOT NULL,
    join_min_realm character varying(64) DEFAULT '凡人'::character varying NOT NULL,
    member_count integer DEFAULT 1 NOT NULL,
    max_members integer DEFAULT 20 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sect_def; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_def IS '宗门定义表';


--
-- Name: COLUMN sect_def.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.id IS '宗门ID';


--
-- Name: COLUMN sect_def.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.name IS '宗门名称（唯一）';


--
-- Name: COLUMN sect_def.leader_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.leader_id IS '宗主角色ID';


--
-- Name: COLUMN sect_def.level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.level IS '宗门等级';


--
-- Name: COLUMN sect_def.exp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.exp IS '宗门经验';


--
-- Name: COLUMN sect_def.funds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.funds IS '宗门资金';


--
-- Name: COLUMN sect_def.reputation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.reputation IS '宗门声望';


--
-- Name: COLUMN sect_def.build_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.build_points IS '建设点';


--
-- Name: COLUMN sect_def.announcement; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.announcement IS '宗门公告';


--
-- Name: COLUMN sect_def.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.description IS '宗门简介';


--
-- Name: COLUMN sect_def.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.icon IS '宗门图标';


--
-- Name: COLUMN sect_def.join_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.join_type IS '加入方式（open/apply/invite）';


--
-- Name: COLUMN sect_def.join_min_realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.join_min_realm IS '加入最低境界';


--
-- Name: COLUMN sect_def.member_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.member_count IS '当前成员数';


--
-- Name: COLUMN sect_def.max_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.max_members IS '最大成员数';


--
-- Name: COLUMN sect_def.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.created_at IS '创建时间';


--
-- Name: COLUMN sect_def.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_def.updated_at IS '更新时间';


--
-- Name: sect_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_log (
    id bigint NOT NULL,
    sect_id character varying(64) NOT NULL,
    log_type character varying(32) NOT NULL,
    operator_id integer,
    target_id integer,
    content text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sect_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_log IS '宗门日志表';


--
-- Name: COLUMN sect_log.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.id IS '日志ID';


--
-- Name: COLUMN sect_log.sect_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.sect_id IS '宗门ID';


--
-- Name: COLUMN sect_log.log_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.log_type IS '日志类型';


--
-- Name: COLUMN sect_log.operator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.operator_id IS '操作人角色ID';


--
-- Name: COLUMN sect_log.target_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.target_id IS '目标角色ID';


--
-- Name: COLUMN sect_log.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.content IS '日志内容';


--
-- Name: COLUMN sect_log.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_log.created_at IS '创建时间';


--
-- Name: sect_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sect_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sect_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sect_log_id_seq OWNED BY public.sect_log.id;


--
-- Name: sect_member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_member (
    id bigint NOT NULL,
    sect_id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    "position" character varying(32) DEFAULT 'disciple'::character varying NOT NULL,
    contribution bigint DEFAULT 0 NOT NULL,
    weekly_contribution integer DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sect_member; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_member IS '宗门成员表';


--
-- Name: COLUMN sect_member.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.id IS '成员记录ID';


--
-- Name: COLUMN sect_member.sect_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.sect_id IS '宗门ID';


--
-- Name: COLUMN sect_member.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.character_id IS '角色ID（唯一，只能加入一个宗门）';


--
-- Name: COLUMN sect_member."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member."position" IS '职位（leader/vice_leader/elder/elite/disciple）';


--
-- Name: COLUMN sect_member.contribution; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.contribution IS '累计贡献';


--
-- Name: COLUMN sect_member.weekly_contribution; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.weekly_contribution IS '本周贡献';


--
-- Name: COLUMN sect_member.joined_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_member.joined_at IS '加入时间';


--
-- Name: sect_member_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sect_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sect_member_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sect_member_id_seq OWNED BY public.sect_member.id;


--
-- Name: sect_quest_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sect_quest_progress (
    id bigint NOT NULL,
    character_id integer NOT NULL,
    quest_id character varying(64) NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    status character varying(32) DEFAULT 'in_progress'::character varying NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: TABLE sect_quest_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sect_quest_progress IS '宗门任务进度表';


--
-- Name: COLUMN sect_quest_progress.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.id IS '进度记录ID';


--
-- Name: COLUMN sect_quest_progress.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.character_id IS '角色ID';


--
-- Name: COLUMN sect_quest_progress.quest_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.quest_id IS '任务ID';


--
-- Name: COLUMN sect_quest_progress.progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.progress IS '当前进度';


--
-- Name: COLUMN sect_quest_progress.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.status IS '状态（in_progress/completed/claimed）';


--
-- Name: COLUMN sect_quest_progress.accepted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.accepted_at IS '接取时间';


--
-- Name: COLUMN sect_quest_progress.completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sect_quest_progress.completed_at IS '完成时间';


--
-- Name: sect_quest_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sect_quest_progress_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sect_quest_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sect_quest_progress_id_seq OWNED BY public.sect_quest_progress.id;


--
-- Name: sign_in_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sign_in_records (
    id integer NOT NULL,
    user_id integer NOT NULL,
    sign_date date NOT NULL,
    reward integer NOT NULL,
    is_holiday boolean DEFAULT false,
    holiday_name character varying(50) DEFAULT NULL::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE sign_in_records; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sign_in_records IS '玩家签到记录表';


--
-- Name: COLUMN sign_in_records.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.id IS '签到记录ID，自增主键';


--
-- Name: COLUMN sign_in_records.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.user_id IS '关联用户ID';


--
-- Name: COLUMN sign_in_records.sign_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.sign_date IS '签到日期（自然日）';


--
-- Name: COLUMN sign_in_records.reward; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.reward IS '获得灵石数量';


--
-- Name: COLUMN sign_in_records.is_holiday; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.is_holiday IS '是否节假日签到';


--
-- Name: COLUMN sign_in_records.holiday_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.holiday_name IS '节假日名称';


--
-- Name: COLUMN sign_in_records.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sign_in_records.created_at IS '创建时间';


--
-- Name: sign_in_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sign_in_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sign_in_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sign_in_records_id_seq OWNED BY public.sign_in_records.id;


--
-- Name: task_def; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_def (
    id character varying(64) NOT NULL,
    category character varying(16) DEFAULT 'main'::character varying NOT NULL,
    title character varying(128) NOT NULL,
    realm character varying(64) DEFAULT '凡人'::character varying NOT NULL,
    description text,
    giver_npc_id character varying(64),
    map_id character varying(64),
    room_id character varying(64),
    objectives jsonb DEFAULT '[]'::jsonb NOT NULL,
    rewards jsonb DEFAULT '[]'::jsonb NOT NULL,
    prereq_task_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_weight integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE task_def; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.task_def IS '动态任务扩展表（用于悬赏等运行时生成任务）';


--
-- Name: COLUMN task_def.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.id IS '任务ID';


--
-- Name: COLUMN task_def.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.category IS '任务类别（main主线/side支线/daily日常/event活动）';


--
-- Name: COLUMN task_def.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.title IS '任务标题';


--
-- Name: COLUMN task_def.realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.realm IS '推荐境界';


--
-- Name: COLUMN task_def.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.description IS '任务描述';


--
-- Name: COLUMN task_def.giver_npc_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.giver_npc_id IS '发布NPC ID（可为空）';


--
-- Name: COLUMN task_def.map_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.map_id IS '任务发生地图ID（可为空）';


--
-- Name: COLUMN task_def.room_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.room_id IS '任务发生房间ID（可为空）';


--
-- Name: COLUMN task_def.objectives; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.objectives IS '任务目标列表（JSON）';


--
-- Name: COLUMN task_def.rewards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.rewards IS '任务奖励列表（JSON）';


--
-- Name: COLUMN task_def.prereq_task_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.prereq_task_ids IS '前置任务ID列表（JSON）';


--
-- Name: COLUMN task_def.enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.enabled IS '是否启用';


--
-- Name: COLUMN task_def.sort_weight; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.sort_weight IS '排序权重';


--
-- Name: COLUMN task_def.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.version IS '配置版本';


--
-- Name: COLUMN task_def.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.created_at IS '创建时间';


--
-- Name: COLUMN task_def.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_def.updated_at IS '更新时间';


--
-- Name: team_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_applications (
    id character varying(64) NOT NULL,
    team_id character varying(64) NOT NULL,
    applicant_id integer NOT NULL,
    message character varying(200) DEFAULT NULL::character varying,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    handled_at timestamp without time zone
);


--
-- Name: TABLE team_applications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_applications IS '入队申请表';


--
-- Name: COLUMN team_applications.team_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_applications.team_id IS '队伍ID';


--
-- Name: COLUMN team_applications.applicant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_applications.applicant_id IS '申请者角色ID';


--
-- Name: COLUMN team_applications.message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_applications.message IS '申请留言';


--
-- Name: COLUMN team_applications.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_applications.status IS '状态：pending待处理/approved已通过/rejected已拒绝/expired已过期';


--
-- Name: team_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invitations (
    id character varying(64) NOT NULL,
    team_id character varying(64) NOT NULL,
    inviter_id integer NOT NULL,
    invitee_id integer NOT NULL,
    message character varying(200) DEFAULT NULL::character varying,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    handled_at timestamp without time zone
);


--
-- Name: TABLE team_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_invitations IS '入队邀请表';


--
-- Name: COLUMN team_invitations.team_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.team_id IS '队伍ID';


--
-- Name: COLUMN team_invitations.inviter_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.inviter_id IS '邀请者角色ID';


--
-- Name: COLUMN team_invitations.invitee_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.invitee_id IS '被邀请者角色ID';


--
-- Name: COLUMN team_invitations.message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.message IS '邀请留言';


--
-- Name: COLUMN team_invitations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.status IS '状态：pending待处理/accepted已接受/rejected已拒绝/expired已过期';


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id integer NOT NULL,
    team_id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying,
    joined_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE team_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_members IS '队伍成员表';


--
-- Name: COLUMN team_members.team_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_members.team_id IS '队伍ID';


--
-- Name: COLUMN team_members.character_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_members.character_id IS '角色ID';


--
-- Name: COLUMN team_members.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_members.role IS '角色：leader队长/member队员';


--
-- Name: COLUMN team_members.joined_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_members.joined_at IS '加入时间';


--
-- Name: team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_members_id_seq OWNED BY public.team_members.id;


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id character varying(64) NOT NULL,
    name character varying(50) NOT NULL,
    leader_id integer NOT NULL,
    goal character varying(50) DEFAULT '组队冒险'::character varying,
    join_min_realm character varying(50) DEFAULT '凡人'::character varying,
    auto_join_enabled boolean DEFAULT false,
    auto_join_min_realm character varying(50) DEFAULT '凡人'::character varying,
    max_members integer DEFAULT 5,
    current_map_id character varying(64) DEFAULT NULL::character varying,
    is_public boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE teams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.teams IS '队伍表';


--
-- Name: COLUMN teams.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.id IS '队伍ID (UUID)';


--
-- Name: COLUMN teams.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.name IS '队伍名称';


--
-- Name: COLUMN teams.leader_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.leader_id IS '队长角色ID';


--
-- Name: COLUMN teams.goal; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.goal IS '队伍目标';


--
-- Name: COLUMN teams.join_min_realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.join_min_realm IS '申请最低境界要求';


--
-- Name: COLUMN teams.auto_join_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.auto_join_enabled IS '是否开启自动入队';


--
-- Name: COLUMN teams.auto_join_min_realm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.auto_join_min_realm IS '自动入队最低境界';


--
-- Name: COLUMN teams.max_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.max_members IS '最大成员数';


--
-- Name: COLUMN teams.current_map_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.current_map_id IS '队伍当前地图ID';


--
-- Name: COLUMN teams.is_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.is_public IS '是否公开';


--
-- Name: technique_generation_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.technique_generation_job (
    id character varying(64) NOT NULL,
    character_id integer NOT NULL,
    week_key character varying(16) NOT NULL,
    status character varying(32) NOT NULL,
    quality_rolled character varying(4) NOT NULL,
    cost_points integer NOT NULL,
    prompt_snapshot jsonb,
    model_name character varying(64),
    attempt_count integer DEFAULT 0 NOT NULL,
    draft_technique_id character varying(64),
    generated_technique_id character varying(64),
    publish_attempts integer DEFAULT 0 NOT NULL,
    draft_expire_at timestamp with time zone,
    error_code character varying(32),
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    viewed_at timestamp with time zone,
    failed_viewed_at timestamp with time zone,
    finished_at timestamp with time zone,
    type_rolled character varying(16),
    used_cooldown_bypass_token boolean DEFAULT false NOT NULL,
    burning_word_prompt character varying(8)
);


--
-- Name: TABLE technique_generation_job; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.technique_generation_job IS 'AI生成功法任务表';


--
-- Name: COLUMN technique_generation_job.viewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.technique_generation_job.viewed_at IS '生成成功结果首次被玩家查看时间';


--
-- Name: COLUMN technique_generation_job.failed_viewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.technique_generation_job.failed_viewed_at IS '生成失败结果首次被玩家查看时间';


--
-- Name: COLUMN technique_generation_job.finished_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.technique_generation_job.finished_at IS '异步生成任务结束时间';


--
-- Name: COLUMN technique_generation_job.type_rolled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.technique_generation_job.type_rolled IS '程序预先随机出的功法类型';


--
-- Name: tower_frozen_frontier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tower_frozen_frontier (
    scope character varying(32) DEFAULT 'tower'::character varying NOT NULL,
    frozen_floor_max integer DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tower_frozen_monster_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tower_frozen_monster_snapshot (
    id bigint NOT NULL,
    frozen_floor_max integer NOT NULL,
    kind character varying(16) NOT NULL,
    realm character varying(64) NOT NULL,
    monster_def_id character varying(64) NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tower_frozen_monster_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tower_frozen_monster_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tower_frozen_monster_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tower_frozen_monster_snapshot_id_seq OWNED BY public.tower_frozen_monster_snapshot.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_login timestamp without time zone,
    status smallint DEFAULT 1,
    session_token character varying(255),
    phone_number character varying(20)
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS '用户账号表';


--
-- Name: COLUMN users.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.id IS '用户ID，自增主键';


--
-- Name: COLUMN users.username; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.username IS '用户名，唯一且不能为空';


--
-- Name: COLUMN users.password; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.password IS '密码，加密存储';


--
-- Name: COLUMN users.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.created_at IS '创建时间';


--
-- Name: COLUMN users.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.updated_at IS '更新时间';


--
-- Name: COLUMN users.last_login; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.last_login IS '最后登录时间';


--
-- Name: COLUMN users.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.status IS '账号状态：1正常 0禁用';


--
-- Name: COLUMN users.session_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.session_token IS '当前会话token，用于单点登录';


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: afdian_message_delivery id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afdian_message_delivery ALTER COLUMN id SET DEFAULT nextval('public.afdian_message_delivery_id_seq'::regclass);


--
-- Name: afdian_order id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afdian_order ALTER COLUMN id SET DEFAULT nextval('public.afdian_order_id_seq'::regclass);


--
-- Name: battle_pass_claim_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_claim_record ALTER COLUMN id SET DEFAULT nextval('public.battle_pass_claim_record_id_seq'::regclass);


--
-- Name: bounty_claim id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_claim ALTER COLUMN id SET DEFAULT nextval('public.bounty_claim_id_seq'::regclass);


--
-- Name: bounty_instance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_instance ALTER COLUMN id SET DEFAULT nextval('public.bounty_instance_id_seq'::regclass);


--
-- Name: character_achievement id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement ALTER COLUMN id SET DEFAULT nextval('public.character_achievement_id_seq'::regclass);


--
-- Name: character_feature_unlocks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_feature_unlocks ALTER COLUMN id SET DEFAULT nextval('public.character_feature_unlocks_id_seq'::regclass);


--
-- Name: character_global_buff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_global_buff ALTER COLUMN id SET DEFAULT nextval('public.character_global_buff_id_seq'::regclass);


--
-- Name: character_item_grant_mail_outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_item_grant_mail_outbox ALTER COLUMN id SET DEFAULT nextval('public.character_item_grant_mail_outbox_id_seq'::regclass);


--
-- Name: character_partner id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner ALTER COLUMN id SET DEFAULT nextval('public.character_partner_id_seq'::regclass);


--
-- Name: character_partner_skill_policy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_skill_policy ALTER COLUMN id SET DEFAULT nextval('public.character_partner_skill_policy_id_seq'::regclass);


--
-- Name: character_partner_technique id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_technique ALTER COLUMN id SET DEFAULT nextval('public.character_partner_technique_id_seq'::regclass);


--
-- Name: character_room_resource_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_room_resource_state ALTER COLUMN id SET DEFAULT nextval('public.character_room_resource_state_id_seq'::regclass);


--
-- Name: character_skill_slot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_skill_slot ALTER COLUMN id SET DEFAULT nextval('public.character_skill_slot_id_seq'::regclass);


--
-- Name: character_task_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_task_progress ALTER COLUMN id SET DEFAULT nextval('public.character_task_progress_id_seq'::regclass);


--
-- Name: character_technique id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_technique ALTER COLUMN id SET DEFAULT nextval('public.character_technique_id_seq'::regclass);


--
-- Name: character_title id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_title ALTER COLUMN id SET DEFAULT nextval('public.character_title_id_seq'::regclass);


--
-- Name: characters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters ALTER COLUMN id SET DEFAULT nextval('public.characters_id_seq'::regclass);


--
-- Name: dungeon_entry_count id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_entry_count ALTER COLUMN id SET DEFAULT nextval('public.dungeon_entry_count_id_seq'::regclass);


--
-- Name: dungeon_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_record ALTER COLUMN id SET DEFAULT nextval('public.dungeon_record_id_seq'::regclass);


--
-- Name: generated_technique_layer id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_technique_layer ALTER COLUMN id SET DEFAULT nextval('public.generated_technique_layer_id_seq'::regclass);


--
-- Name: inventory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory ALTER COLUMN id SET DEFAULT nextval('public.inventory_id_seq'::regclass);


--
-- Name: item_instance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_instance ALTER COLUMN id SET DEFAULT nextval('public.item_instance_id_seq'::regclass);


--
-- Name: item_use_cooldown id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_cooldown ALTER COLUMN id SET DEFAULT nextval('public.item_use_cooldown_id_seq'::regclass);


--
-- Name: item_use_count id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_count ALTER COLUMN id SET DEFAULT nextval('public.item_use_count_id_seq'::regclass);


--
-- Name: mail id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail ALTER COLUMN id SET DEFAULT nextval('public.mail_id_seq'::regclass);


--
-- Name: market_listing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing ALTER COLUMN id SET DEFAULT nextval('public.market_listing_id_seq'::regclass);


--
-- Name: market_partner_listing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_partner_listing ALTER COLUMN id SET DEFAULT nextval('public.market_partner_listing_id_seq'::regclass);


--
-- Name: market_partner_trade_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_partner_trade_record ALTER COLUMN id SET DEFAULT nextval('public.market_partner_trade_record_id_seq'::regclass);


--
-- Name: market_trade_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record ALTER COLUMN id SET DEFAULT nextval('public.market_trade_record_id_seq'::regclass);


--
-- Name: month_card_claim_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_claim_record ALTER COLUMN id SET DEFAULT nextval('public.month_card_claim_record_id_seq'::regclass);


--
-- Name: month_card_ownership id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_ownership ALTER COLUMN id SET DEFAULT nextval('public.month_card_ownership_id_seq'::regclass);


--
-- Name: partner_fusion_job_material id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job_material ALTER COLUMN id SET DEFAULT nextval('public.partner_fusion_job_material_id_seq'::regclass);


--
-- Name: redeem_code id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redeem_code ALTER COLUMN id SET DEFAULT nextval('public.redeem_code_id_seq'::regclass);


--
-- Name: research_points_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_points_ledger ALTER COLUMN id SET DEFAULT nextval('public.research_points_ledger_id_seq'::regclass);


--
-- Name: sect_application id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_application ALTER COLUMN id SET DEFAULT nextval('public.sect_application_id_seq'::regclass);


--
-- Name: sect_building id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_building ALTER COLUMN id SET DEFAULT nextval('public.sect_building_id_seq'::regclass);


--
-- Name: sect_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_log ALTER COLUMN id SET DEFAULT nextval('public.sect_log_id_seq'::regclass);


--
-- Name: sect_member id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_member ALTER COLUMN id SET DEFAULT nextval('public.sect_member_id_seq'::regclass);


--
-- Name: sect_quest_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_quest_progress ALTER COLUMN id SET DEFAULT nextval('public.sect_quest_progress_id_seq'::regclass);


--
-- Name: sign_in_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_records ALTER COLUMN id SET DEFAULT nextval('public.sign_in_records_id_seq'::regclass);


--
-- Name: team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members ALTER COLUMN id SET DEFAULT nextval('public.team_members_id_seq'::regclass);


--
-- Name: tower_frozen_monster_snapshot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tower_frozen_monster_snapshot ALTER COLUMN id SET DEFAULT nextval('public.tower_frozen_monster_snapshot_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: afdian_message_delivery afdian_message_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afdian_message_delivery
    ADD CONSTRAINT afdian_message_delivery_pkey PRIMARY KEY (id);


--
-- Name: afdian_order afdian_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afdian_order
    ADD CONSTRAINT afdian_order_pkey PRIMARY KEY (id);


--
-- Name: arena_battle arena_battle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_battle
    ADD CONSTRAINT arena_battle_pkey PRIMARY KEY (battle_id);


--
-- Name: arena_rating arena_rating_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_rating
    ADD CONSTRAINT arena_rating_pkey PRIMARY KEY (character_id);


--
-- Name: arena_weekly_settlement arena_weekly_settlement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_weekly_settlement
    ADD CONSTRAINT arena_weekly_settlement_pkey PRIMARY KEY (week_start_local_date);


--
-- Name: battle_pass_claim_record battle_pass_claim_record_character_id_season_id_level_track_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_claim_record
    ADD CONSTRAINT battle_pass_claim_record_character_id_season_id_level_track_key UNIQUE (character_id, season_id, level, track);


--
-- Name: battle_pass_claim_record battle_pass_claim_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_claim_record
    ADD CONSTRAINT battle_pass_claim_record_pkey PRIMARY KEY (id);


--
-- Name: battle_pass_progress battle_pass_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_progress
    ADD CONSTRAINT battle_pass_progress_pkey PRIMARY KEY (character_id, season_id);


--
-- Name: battle_pass_task_progress battle_pass_task_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_task_progress
    ADD CONSTRAINT battle_pass_task_progress_pkey PRIMARY KEY (character_id, season_id, task_id);


--
-- Name: bounty_claim bounty_claim_bounty_instance_id_character_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_claim
    ADD CONSTRAINT bounty_claim_bounty_instance_id_character_id_key UNIQUE (bounty_instance_id, character_id);


--
-- Name: bounty_claim bounty_claim_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_claim
    ADD CONSTRAINT bounty_claim_pkey PRIMARY KEY (id);


--
-- Name: bounty_instance bounty_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_instance
    ADD CONSTRAINT bounty_instance_pkey PRIMARY KEY (id);


--
-- Name: character_achievement_battle_state character_achievement_battle_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement_battle_state
    ADD CONSTRAINT character_achievement_battle_state_pkey PRIMARY KEY (character_id);


--
-- Name: character_achievement character_achievement_character_id_achievement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement
    ADD CONSTRAINT character_achievement_character_id_achievement_id_key UNIQUE (character_id, achievement_id);


--
-- Name: character_achievement character_achievement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement
    ADD CONSTRAINT character_achievement_pkey PRIMARY KEY (id);


--
-- Name: character_achievement_points character_achievement_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement_points
    ADD CONSTRAINT character_achievement_points_pkey PRIMARY KEY (character_id);


--
-- Name: character_feature_unlocks character_feature_unlocks_character_id_feature_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_feature_unlocks
    ADD CONSTRAINT character_feature_unlocks_character_id_feature_code_key UNIQUE (character_id, feature_code);


--
-- Name: character_feature_unlocks character_feature_unlocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_feature_unlocks
    ADD CONSTRAINT character_feature_unlocks_pkey PRIMARY KEY (id);


--
-- Name: character_global_buff character_global_buff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_global_buff
    ADD CONSTRAINT character_global_buff_pkey PRIMARY KEY (id);


--
-- Name: character_insight_progress character_insight_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_insight_progress
    ADD CONSTRAINT character_insight_progress_pkey PRIMARY KEY (character_id);


--
-- Name: character_item_grant_mail_outbox character_item_grant_mail_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_item_grant_mail_outbox
    ADD CONSTRAINT character_item_grant_mail_outbox_pkey PRIMARY KEY (id);


--
-- Name: character_main_quest_progress character_main_quest_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_main_quest_progress
    ADD CONSTRAINT character_main_quest_progress_pkey PRIMARY KEY (character_id);


--
-- Name: character_partner character_partner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner
    ADD CONSTRAINT character_partner_pkey PRIMARY KEY (id);


--
-- Name: character_partner_skill_policy character_partner_skill_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_skill_policy
    ADD CONSTRAINT character_partner_skill_policy_pkey PRIMARY KEY (id);


--
-- Name: character_partner_technique character_partner_technique_partner_id_technique_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_technique
    ADD CONSTRAINT character_partner_technique_partner_id_technique_id_key UNIQUE (partner_id, technique_id);


--
-- Name: character_partner_technique character_partner_technique_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_technique
    ADD CONSTRAINT character_partner_technique_pkey PRIMARY KEY (id);


--
-- Name: character_rank_snapshot character_rank_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_rank_snapshot
    ADD CONSTRAINT character_rank_snapshot_pkey PRIMARY KEY (character_id);


--
-- Name: character_research_points character_research_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_research_points
    ADD CONSTRAINT character_research_points_pkey PRIMARY KEY (character_id);


--
-- Name: character_room_resource_state character_room_resource_state_character_id_map_id_room_id_r_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_room_resource_state
    ADD CONSTRAINT character_room_resource_state_character_id_map_id_room_id_r_key UNIQUE (character_id, map_id, room_id, resource_id);


--
-- Name: character_room_resource_state character_room_resource_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_room_resource_state
    ADD CONSTRAINT character_room_resource_state_pkey PRIMARY KEY (id);


--
-- Name: character_skill_slot character_skill_slot_character_id_skill_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_skill_slot
    ADD CONSTRAINT character_skill_slot_character_id_skill_id_key UNIQUE (character_id, skill_id);


--
-- Name: character_skill_slot character_skill_slot_character_id_slot_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_skill_slot
    ADD CONSTRAINT character_skill_slot_character_id_slot_index_key UNIQUE (character_id, slot_index);


--
-- Name: character_skill_slot character_skill_slot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_skill_slot
    ADD CONSTRAINT character_skill_slot_pkey PRIMARY KEY (id);


--
-- Name: character_task_progress character_task_progress_character_id_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_task_progress
    ADD CONSTRAINT character_task_progress_character_id_task_id_key UNIQUE (character_id, task_id);


--
-- Name: character_task_progress character_task_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_task_progress
    ADD CONSTRAINT character_task_progress_pkey PRIMARY KEY (id);


--
-- Name: character_technique character_technique_character_id_technique_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_technique
    ADD CONSTRAINT character_technique_character_id_technique_id_key UNIQUE (character_id, technique_id);


--
-- Name: character_technique character_technique_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_technique
    ADD CONSTRAINT character_technique_pkey PRIMARY KEY (id);


--
-- Name: character_title character_title_character_id_title_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_title
    ADD CONSTRAINT character_title_character_id_title_id_key UNIQUE (character_id, title_id);


--
-- Name: character_title character_title_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_title
    ADD CONSTRAINT character_title_pkey PRIMARY KEY (id);


--
-- Name: character_tower_progress character_tower_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_tower_progress
    ADD CONSTRAINT character_tower_progress_pkey PRIMARY KEY (character_id);


--
-- Name: character_wander_generation_job character_wander_generation_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_generation_job
    ADD CONSTRAINT character_wander_generation_job_pkey PRIMARY KEY (id);


--
-- Name: character_wander_story_episode character_wander_story_episode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_story_episode
    ADD CONSTRAINT character_wander_story_episode_pkey PRIMARY KEY (id);


--
-- Name: character_wander_story character_wander_story_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_story
    ADD CONSTRAINT character_wander_story_pkey PRIMARY KEY (id);


--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_pkey PRIMARY KEY (id);


--
-- Name: characters characters_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_user_id_key UNIQUE (user_id);


--
-- Name: dungeon_entry_count dungeon_entry_count_character_id_dungeon_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_entry_count
    ADD CONSTRAINT dungeon_entry_count_character_id_dungeon_id_key UNIQUE (character_id, dungeon_id);


--
-- Name: dungeon_entry_count dungeon_entry_count_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_entry_count
    ADD CONSTRAINT dungeon_entry_count_pkey PRIMARY KEY (id);


--
-- Name: dungeon_instance dungeon_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_instance
    ADD CONSTRAINT dungeon_instance_pkey PRIMARY KEY (id);


--
-- Name: dungeon_record dungeon_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_record
    ADD CONSTRAINT dungeon_record_pkey PRIMARY KEY (id);


--
-- Name: game_time game_time_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_time
    ADD CONSTRAINT game_time_pkey PRIMARY KEY (id);


--
-- Name: generated_partner_def generated_partner_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_partner_def
    ADD CONSTRAINT generated_partner_def_pkey PRIMARY KEY (id);


--
-- Name: generated_partner_def generated_partner_def_source_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_partner_def
    ADD CONSTRAINT generated_partner_def_source_job_id_key UNIQUE (source_job_id);


--
-- Name: generated_skill_def generated_skill_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_skill_def
    ADD CONSTRAINT generated_skill_def_pkey PRIMARY KEY (id);


--
-- Name: generated_technique_def generated_technique_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_technique_def
    ADD CONSTRAINT generated_technique_def_pkey PRIMARY KEY (id);


--
-- Name: generated_technique_layer generated_technique_layer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_technique_layer
    ADD CONSTRAINT generated_technique_layer_pkey PRIMARY KEY (id);


--
-- Name: generated_technique_layer generated_technique_layer_technique_id_layer_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_technique_layer
    ADD CONSTRAINT generated_technique_layer_technique_id_layer_key UNIQUE (technique_id, layer);


--
-- Name: generated_title_def generated_title_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_title_def
    ADD CONSTRAINT generated_title_def_pkey PRIMARY KEY (id);


--
-- Name: idle_configs idle_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idle_configs
    ADD CONSTRAINT idle_configs_pkey PRIMARY KEY (character_id);


--
-- Name: idle_sessions idle_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idle_sessions
    ADD CONSTRAINT idle_sessions_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_character_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_character_id_key UNIQUE (character_id);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: item_instance item_instance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_instance
    ADD CONSTRAINT item_instance_pkey PRIMARY KEY (id);


--
-- Name: item_use_cooldown item_use_cooldown_character_id_item_def_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_cooldown
    ADD CONSTRAINT item_use_cooldown_character_id_item_def_id_key UNIQUE (character_id, item_def_id);


--
-- Name: item_use_cooldown item_use_cooldown_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_cooldown
    ADD CONSTRAINT item_use_cooldown_pkey PRIMARY KEY (id);


--
-- Name: item_use_count item_use_count_character_id_item_def_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_count
    ADD CONSTRAINT item_use_count_character_id_item_def_id_key UNIQUE (character_id, item_def_id);


--
-- Name: item_use_count item_use_count_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_count
    ADD CONSTRAINT item_use_count_pkey PRIMARY KEY (id);


--
-- Name: mail_counter mail_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_counter
    ADD CONSTRAINT mail_counter_pkey PRIMARY KEY (scope_type, scope_id);


--
-- Name: mail mail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail
    ADD CONSTRAINT mail_pkey PRIMARY KEY (id);


--
-- Name: market_listing market_listing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_pkey PRIMARY KEY (id);


--
-- Name: market_partner_listing market_partner_listing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_partner_listing
    ADD CONSTRAINT market_partner_listing_pkey PRIMARY KEY (id);


--
-- Name: market_partner_trade_record market_partner_trade_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_partner_trade_record
    ADD CONSTRAINT market_partner_trade_record_pkey PRIMARY KEY (id);


--
-- Name: market_trade_record market_trade_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_pkey PRIMARY KEY (id);


--
-- Name: month_card_claim_record month_card_claim_record_character_id_month_card_id_claim_da_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_claim_record
    ADD CONSTRAINT month_card_claim_record_character_id_month_card_id_claim_da_key UNIQUE (character_id, month_card_id, claim_date);


--
-- Name: month_card_claim_record month_card_claim_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_claim_record
    ADD CONSTRAINT month_card_claim_record_pkey PRIMARY KEY (id);


--
-- Name: month_card_ownership month_card_ownership_character_id_month_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_ownership
    ADD CONSTRAINT month_card_ownership_character_id_month_card_id_key UNIQUE (character_id, month_card_id);


--
-- Name: month_card_ownership month_card_ownership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_ownership
    ADD CONSTRAINT month_card_ownership_pkey PRIMARY KEY (id);


--
-- Name: online_battle_settlement_task online_battle_settlement_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_battle_settlement_task
    ADD CONSTRAINT online_battle_settlement_task_pkey PRIMARY KEY (id);


--
-- Name: partner_fusion_job_material partner_fusion_job_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job_material
    ADD CONSTRAINT partner_fusion_job_material_pkey PRIMARY KEY (id);


--
-- Name: partner_fusion_job partner_fusion_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job
    ADD CONSTRAINT partner_fusion_job_pkey PRIMARY KEY (id);


--
-- Name: partner_rank_snapshot partner_rank_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_rank_snapshot
    ADD CONSTRAINT partner_rank_snapshot_pkey PRIMARY KEY (partner_id);


--
-- Name: partner_rebone_job partner_rebone_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_rebone_job
    ADD CONSTRAINT partner_rebone_job_pkey PRIMARY KEY (id);


--
-- Name: partner_recruit_job partner_recruit_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_recruit_job
    ADD CONSTRAINT partner_recruit_job_pkey PRIMARY KEY (id);


--
-- Name: redeem_code redeem_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redeem_code
    ADD CONSTRAINT redeem_code_pkey PRIMARY KEY (id);


--
-- Name: research_points_ledger research_points_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_points_ledger
    ADD CONSTRAINT research_points_ledger_pkey PRIMARY KEY (id);


--
-- Name: sect_application sect_application_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_application
    ADD CONSTRAINT sect_application_pkey PRIMARY KEY (id);


--
-- Name: sect_building sect_building_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_building
    ADD CONSTRAINT sect_building_pkey PRIMARY KEY (id);


--
-- Name: sect_building sect_building_sect_id_building_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_building
    ADD CONSTRAINT sect_building_sect_id_building_type_key UNIQUE (sect_id, building_type);


--
-- Name: sect_def sect_def_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_def
    ADD CONSTRAINT sect_def_name_key UNIQUE (name);


--
-- Name: sect_def sect_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_def
    ADD CONSTRAINT sect_def_pkey PRIMARY KEY (id);


--
-- Name: sect_log sect_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_log
    ADD CONSTRAINT sect_log_pkey PRIMARY KEY (id);


--
-- Name: sect_member sect_member_character_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_member
    ADD CONSTRAINT sect_member_character_id_key UNIQUE (character_id);


--
-- Name: sect_member sect_member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_member
    ADD CONSTRAINT sect_member_pkey PRIMARY KEY (id);


--
-- Name: sect_quest_progress sect_quest_progress_character_id_quest_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_quest_progress
    ADD CONSTRAINT sect_quest_progress_character_id_quest_id_key UNIQUE (character_id, quest_id);


--
-- Name: sect_quest_progress sect_quest_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_quest_progress
    ADD CONSTRAINT sect_quest_progress_pkey PRIMARY KEY (id);


--
-- Name: sign_in_records sign_in_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_records
    ADD CONSTRAINT sign_in_records_pkey PRIMARY KEY (id);


--
-- Name: sign_in_records sign_in_records_user_id_sign_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_records
    ADD CONSTRAINT sign_in_records_user_id_sign_date_key UNIQUE (user_id, sign_date);


--
-- Name: task_def task_def_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_def
    ADD CONSTRAINT task_def_pkey PRIMARY KEY (id);


--
-- Name: team_applications team_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_applications
    ADD CONSTRAINT team_applications_pkey PRIMARY KEY (id);


--
-- Name: team_applications team_applications_team_id_applicant_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_applications
    ADD CONSTRAINT team_applications_team_id_applicant_id_status_key UNIQUE (team_id, applicant_id, status);


--
-- Name: team_invitations team_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_pkey PRIMARY KEY (id);


--
-- Name: team_invitations team_invitations_team_id_invitee_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_team_id_invitee_id_status_key UNIQUE (team_id, invitee_id, status);


--
-- Name: team_members team_members_character_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_character_id_key UNIQUE (character_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_team_id_character_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_character_id_key UNIQUE (team_id, character_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: technique_generation_job technique_generation_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technique_generation_job
    ADD CONSTRAINT technique_generation_job_pkey PRIMARY KEY (id);


--
-- Name: tower_frozen_frontier tower_frozen_frontier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tower_frozen_frontier
    ADD CONSTRAINT tower_frozen_frontier_pkey PRIMARY KEY (scope);


--
-- Name: tower_frozen_monster_snapshot tower_frozen_monster_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tower_frozen_monster_snapshot
    ADD CONSTRAINT tower_frozen_monster_snapshot_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: afdian_message_delivery_order_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX afdian_message_delivery_order_id_key ON public.afdian_message_delivery USING btree (order_id);


--
-- Name: afdian_order_out_trade_no_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX afdian_order_out_trade_no_key ON public.afdian_order USING btree (out_trade_no);


--
-- Name: character_partner_skill_policy_partner_id_skill_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX character_partner_skill_policy_partner_id_skill_id_key ON public.character_partner_skill_policy USING btree (partner_id, skill_id);


--
-- Name: character_wander_story_episode_character_id_day_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX character_wander_story_episode_character_id_day_key_key ON public.character_wander_story_episode USING btree (character_id, day_key);


--
-- Name: generated_title_def_source_type_source_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX generated_title_def_source_type_source_id_key ON public.generated_title_def USING btree (source_type, source_id);


--
-- Name: idx_afdian_message_delivery_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_afdian_message_delivery_retry ON public.afdian_message_delivery USING btree (status, next_retry_at, id);


--
-- Name: idx_afdian_order_plan_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_afdian_order_plan_id ON public.afdian_order USING btree (plan_id);


--
-- Name: idx_afdian_order_sponsor_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_afdian_order_sponsor_time ON public.afdian_order USING btree (sponsor_user_id, created_at DESC);


--
-- Name: idx_arena_battle_challenger_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arena_battle_challenger_time ON public.arena_battle USING btree (challenger_character_id, created_at DESC);


--
-- Name: idx_arena_battle_opponent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arena_battle_opponent_time ON public.arena_battle USING btree (opponent_character_id, created_at DESC);


--
-- Name: idx_arena_battle_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arena_battle_status_time ON public.arena_battle USING btree (status, created_at DESC);


--
-- Name: idx_arena_weekly_settlement_settled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arena_weekly_settlement_settled_at ON public.arena_weekly_settlement USING btree (settled_at DESC);


--
-- Name: idx_battle_pass_claim_record_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battle_pass_claim_record_character ON public.battle_pass_claim_record USING btree (character_id, claimed_at DESC);


--
-- Name: idx_battle_pass_progress_season; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battle_pass_progress_season ON public.battle_pass_progress USING btree (season_id);


--
-- Name: idx_battle_pass_task_progress_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battle_pass_task_progress_character ON public.battle_pass_task_progress USING btree (character_id, season_id, claimed, completed);


--
-- Name: idx_bounty_claim_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bounty_claim_character ON public.bounty_claim USING btree (character_id, claimed_at DESC);


--
-- Name: idx_bounty_claim_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bounty_claim_instance ON public.bounty_claim USING btree (bounty_instance_id, claimed_at DESC);


--
-- Name: idx_bounty_instance_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bounty_instance_daily_date ON public.bounty_instance USING btree (source_type, refresh_date, id DESC);


--
-- Name: idx_bounty_instance_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bounty_instance_expires ON public.bounty_instance USING btree (expires_at);


--
-- Name: idx_char_skill_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_char_skill_char ON public.character_skill_slot USING btree (character_id);


--
-- Name: idx_char_tech_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_char_tech_char ON public.character_technique USING btree (character_id);


--
-- Name: idx_char_tech_equipped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_char_tech_equipped ON public.character_technique USING btree (character_id) WHERE (slot_type IS NOT NULL);


--
-- Name: idx_char_tech_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_char_tech_slot ON public.character_technique USING btree (character_id, slot_type);


--
-- Name: idx_character_achievement_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_achievement_character ON public.character_achievement USING btree (character_id, achievement_id);


--
-- Name: idx_character_achievement_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_achievement_status ON public.character_achievement USING btree (character_id, status, updated_at DESC);


--
-- Name: idx_character_feature_unlocks_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_feature_unlocks_character_id ON public.character_feature_unlocks USING btree (character_id);


--
-- Name: idx_character_feature_unlocks_feature_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_feature_unlocks_feature_code ON public.character_feature_unlocks USING btree (feature_code);


--
-- Name: idx_character_global_buff_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_global_buff_active ON public.character_global_buff USING btree (character_id, expire_at);


--
-- Name: idx_character_global_buff_buff_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_global_buff_buff_key ON public.character_global_buff USING btree (character_id, buff_key);


--
-- Name: idx_character_insight_progress_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_insight_progress_level ON public.character_insight_progress USING btree (level);


--
-- Name: idx_character_item_grant_mail_outbox_character_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_item_grant_mail_outbox_character_queue ON public.character_item_grant_mail_outbox USING btree (character_id, status, next_attempt_at, created_at, id);


--
-- Name: idx_character_item_grant_mail_outbox_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_item_grant_mail_outbox_queue ON public.character_item_grant_mail_outbox USING btree (status, next_attempt_at, created_at, id);


--
-- Name: idx_character_partner_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_character_partner_active_unique ON public.character_partner USING btree (character_id) WHERE (is_active = true);


--
-- Name: idx_character_partner_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_partner_character_id ON public.character_partner USING btree (character_id);


--
-- Name: idx_character_partner_skill_policy_partner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_partner_skill_policy_partner_id ON public.character_partner_skill_policy USING btree (partner_id);


--
-- Name: idx_character_partner_technique_partner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_partner_technique_partner_id ON public.character_partner_technique USING btree (partner_id);


--
-- Name: idx_character_rank_snapshot_realm_power; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_rank_snapshot_realm_power ON public.character_rank_snapshot USING btree (realm_rank DESC, power DESC, character_id);


--
-- Name: idx_character_task_progress_active_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_task_progress_active_lookup ON public.character_task_progress USING btree (character_id, status, task_id) INCLUDE (progress, tracked, accepted_at, completed_at, claimed_at) WHERE ((status)::text IS DISTINCT FROM 'claimed'::text);


--
-- Name: idx_character_task_progress_character_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_task_progress_character_status ON public.character_task_progress USING btree (character_id, status, accepted_at DESC);


--
-- Name: idx_character_task_progress_tracked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_task_progress_tracked ON public.character_task_progress USING btree (character_id, tracked);


--
-- Name: idx_character_title_active_validity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_title_active_validity ON public.character_title USING btree (character_id, is_equipped, expires_at);


--
-- Name: idx_character_title_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_title_character ON public.character_title USING btree (character_id, obtained_at DESC);


--
-- Name: idx_character_title_equipped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_title_equipped ON public.character_title USING btree (character_id, is_equipped);


--
-- Name: idx_character_title_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_title_expires_at ON public.character_title USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_character_tower_progress_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_tower_progress_rank ON public.character_tower_progress USING btree (best_floor DESC, reached_at, character_id);


--
-- Name: idx_character_wander_generation_job_character_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_generation_job_character_day ON public.character_wander_generation_job USING btree (character_id, day_key, created_at DESC);


--
-- Name: idx_character_wander_generation_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_generation_job_status ON public.character_wander_generation_job USING btree (status, created_at DESC);


--
-- Name: idx_character_wander_story_character_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_story_character_created ON public.character_wander_story USING btree (character_id, created_at DESC);


--
-- Name: idx_character_wander_story_character_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_story_character_status ON public.character_wander_story USING btree (character_id, status, updated_at DESC);


--
-- Name: idx_character_wander_story_episode_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_story_episode_character ON public.character_wander_story_episode USING btree (character_id, created_at DESC);


--
-- Name: idx_character_wander_story_episode_story; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_character_wander_story_episode_story ON public.character_wander_story_episode USING btree (story_id, day_index DESC);


--
-- Name: idx_crrs_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crrs_character ON public.character_room_resource_state USING btree (character_id);


--
-- Name: idx_crrs_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crrs_room ON public.character_room_resource_state USING btree (map_id, room_id);


--
-- Name: idx_dungeon_entry_count_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_entry_count_char ON public.dungeon_entry_count USING btree (character_id);


--
-- Name: idx_dungeon_entry_count_dungeon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_entry_count_dungeon ON public.dungeon_entry_count USING btree (dungeon_id);


--
-- Name: idx_dungeon_instance_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_instance_creator ON public.dungeon_instance USING btree (creator_id, created_at DESC);


--
-- Name: idx_dungeon_instance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_instance_status ON public.dungeon_instance USING btree (status, created_at DESC);


--
-- Name: idx_dungeon_instance_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_instance_team ON public.dungeon_instance USING btree (team_id);


--
-- Name: idx_dungeon_record_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_record_char ON public.dungeon_record USING btree (character_id, completed_at DESC);


--
-- Name: idx_dungeon_record_dungeon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dungeon_record_dungeon ON public.dungeon_record USING btree (dungeon_id, completed_at DESC);


--
-- Name: idx_generated_partner_def_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_partner_def_creator ON public.generated_partner_def USING btree (created_by_character_id, created_at DESC);


--
-- Name: idx_generated_partner_def_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_partner_def_enabled ON public.generated_partner_def USING btree (enabled, created_at DESC);


--
-- Name: idx_generated_skill_def_enabled_sort_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_skill_def_enabled_sort_source ON public.generated_skill_def USING btree (sort_weight DESC, id) INCLUDE (source_id) WHERE (enabled = true);


--
-- Name: idx_generated_skill_def_generation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_skill_def_generation_id ON public.generated_skill_def USING btree (generation_id);


--
-- Name: idx_generated_skill_def_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_skill_def_source ON public.generated_skill_def USING btree (source_type, source_id);


--
-- Name: idx_generated_technique_def_generation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_def_generation_id ON public.generated_technique_def USING btree (generation_id);


--
-- Name: idx_generated_technique_def_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_def_published ON public.generated_technique_def USING btree (is_published, enabled, created_at DESC);


--
-- Name: idx_generated_technique_def_published_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_def_published_id ON public.generated_technique_def USING btree (id) WHERE ((is_published = true) AND (enabled = true));


--
-- Name: idx_generated_technique_layer_enabled_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_layer_enabled_order ON public.generated_technique_layer USING btree (technique_id, layer) WHERE (enabled = true);


--
-- Name: idx_generated_technique_layer_generation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_layer_generation_id ON public.generated_technique_layer USING btree (generation_id);


--
-- Name: idx_generated_technique_layer_technique; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_technique_layer_technique ON public.generated_technique_layer USING btree (technique_id, layer);


--
-- Name: idx_generated_title_def_enabled_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generated_title_def_enabled_created ON public.generated_title_def USING btree (enabled, created_at DESC);


--
-- Name: idx_idle_sessions_character_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idle_sessions_character_started ON public.idle_sessions USING btree (character_id, started_at DESC);


--
-- Name: idx_idle_sessions_character_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idle_sessions_character_status ON public.idle_sessions USING btree (character_id, status);


--
-- Name: idx_inventory_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_character ON public.inventory USING btree (character_id);


--
-- Name: idx_item_instance_bag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_bag ON public.item_instance USING btree (owner_character_id, location) WHERE ((location)::text = ANY (ARRAY[('bag'::character varying)::text, ('warehouse'::character varying)::text, ('equipped'::character varying)::text]));


--
-- Name: idx_item_instance_equipped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_equipped ON public.item_instance USING btree (equipped_slot) WHERE (equipped_slot IS NOT NULL);


--
-- Name: idx_item_instance_item_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_item_def ON public.item_instance USING btree (item_def_id);


--
-- Name: idx_item_instance_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_location ON public.item_instance USING btree (location);


--
-- Name: idx_item_instance_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_owner ON public.item_instance USING btree (owner_user_id, owner_character_id);


--
-- Name: idx_item_instance_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_slot ON public.item_instance USING btree (owner_character_id, location, location_slot);


--
-- Name: idx_item_instance_stack; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_stack ON public.item_instance USING btree (owner_character_id, item_def_id, location) WHERE ((location)::text = 'bag'::text);


--
-- Name: idx_item_instance_stackable_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_instance_stackable_lookup ON public.item_instance USING btree (owner_character_id, location, item_def_id, COALESCE(NULLIF(lower(btrim((bind_type)::text)), ''::text), 'none'::text), qty DESC, id) WHERE (((metadata IS NULL) OR (lower(btrim((metadata)::text)) = 'null'::text)) AND ((quality IS NULL) OR (btrim((quality)::text) = ''::text)) AND ((quality_rank IS NULL) OR (quality_rank <= 0)));


--
-- Name: idx_item_use_cooldown_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_use_cooldown_char ON public.item_use_cooldown USING btree (character_id);


--
-- Name: idx_item_use_cooldown_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_use_cooldown_item ON public.item_use_cooldown USING btree (item_def_id);


--
-- Name: idx_item_use_count_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_use_count_char ON public.item_use_count USING btree (character_id);


--
-- Name: idx_item_use_count_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_use_count_item ON public.item_use_count USING btree (item_def_id);


--
-- Name: idx_mail_active_char_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_active_char_created ON public.mail USING btree (recipient_character_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_mail_character_active_counter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_character_active_counter ON public.mail USING btree (recipient_character_id, COALESCE(expire_at, 'infinity'::timestamp with time zone)) INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones) WHERE (deleted_at IS NULL);


--
-- Name: idx_mail_character_active_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_character_active_scope ON public.mail USING btree (recipient_character_id, COALESCE(expire_at, 'infinity'::timestamp with time zone), created_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_mail_character_claim_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_character_claim_queue ON public.mail USING btree (recipient_character_id, deleted_at, claimed_at, created_at, id);


--
-- Name: idx_mail_character_expire_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_character_expire_cleanup ON public.mail USING btree (recipient_character_id, expire_at) WHERE ((deleted_at IS NULL) AND (expire_at IS NOT NULL));


--
-- Name: idx_mail_character_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_character_list ON public.mail USING btree (recipient_character_id, deleted_at, created_at DESC, id DESC);


--
-- Name: idx_mail_cleanup_read_by_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_cleanup_read_by_character ON public.mail USING btree (recipient_character_id, id) WHERE ((deleted_at IS NULL) AND (read_at IS NOT NULL));


--
-- Name: idx_mail_counter_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_counter_updated_at ON public.mail_counter USING btree (updated_at);


--
-- Name: idx_mail_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_created ON public.mail USING btree (created_at DESC);


--
-- Name: idx_mail_deleted_history_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_deleted_history_cleanup ON public.mail USING btree (deleted_at, id) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_mail_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_expire ON public.mail USING btree (expire_at) WHERE ((expire_at IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_mail_expired_history_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_expired_history_cleanup ON public.mail USING btree (expire_at, id) WHERE ((deleted_at IS NULL) AND (expire_at IS NOT NULL));


--
-- Name: idx_mail_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_recipient ON public.mail USING btree (recipient_user_id, recipient_character_id);


--
-- Name: idx_mail_unclaimed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_unclaimed ON public.mail USING btree (recipient_character_id, claimed_at) WHERE ((claimed_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: idx_mail_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_unread ON public.mail USING btree (recipient_character_id, read_at) WHERE ((read_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: idx_mail_user_active_counter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_user_active_counter ON public.mail USING btree (recipient_user_id, COALESCE(expire_at, 'infinity'::timestamp with time zone)) INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones) WHERE ((deleted_at IS NULL) AND (recipient_character_id IS NULL));


--
-- Name: idx_mail_user_active_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_user_active_scope ON public.mail USING btree (recipient_user_id, COALESCE(expire_at, 'infinity'::timestamp with time zone), created_at DESC, id DESC) WHERE ((deleted_at IS NULL) AND (recipient_character_id IS NULL));


--
-- Name: idx_mail_user_claim_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_user_claim_queue ON public.mail USING btree (recipient_user_id, recipient_character_id, deleted_at, claimed_at, created_at, id);


--
-- Name: idx_mail_user_expire_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_user_expire_cleanup ON public.mail USING btree (recipient_user_id, expire_at) WHERE ((recipient_character_id IS NULL) AND (deleted_at IS NULL) AND (expire_at IS NOT NULL));


--
-- Name: idx_mail_user_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_user_list ON public.mail USING btree (recipient_user_id, recipient_character_id, deleted_at, created_at DESC, id DESC);


--
-- Name: idx_market_listing_buyer_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_listing_buyer_character ON public.market_listing USING btree (buyer_character_id);


--
-- Name: idx_market_listing_item_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_listing_item_def_id ON public.market_listing USING btree (item_def_id);


--
-- Name: idx_market_listing_item_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_listing_item_instance_id ON public.market_listing USING btree (item_instance_id) WHERE (item_instance_id IS NOT NULL);


--
-- Name: idx_market_listing_seller_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_listing_seller_character ON public.market_listing USING btree (seller_character_id);


--
-- Name: idx_market_listing_status_listed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_listing_status_listed_at ON public.market_listing USING btree (status, listed_at DESC);


--
-- Name: idx_market_partner_listing_buyer_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_buyer_character ON public.market_partner_listing USING btree (buyer_character_id);


--
-- Name: idx_market_partner_listing_element; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_element ON public.market_partner_listing USING btree (partner_element);


--
-- Name: idx_market_partner_listing_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_partner ON public.market_partner_listing USING btree (partner_id);


--
-- Name: idx_market_partner_listing_quality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_quality ON public.market_partner_listing USING btree (partner_quality);


--
-- Name: idx_market_partner_listing_seller_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_seller_character ON public.market_partner_listing USING btree (seller_character_id);


--
-- Name: idx_market_partner_listing_status_listed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_listing_status_listed_at ON public.market_partner_listing USING btree (status, listed_at DESC);


--
-- Name: idx_market_partner_trade_record_buyer_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_trade_record_buyer_time ON public.market_partner_trade_record USING btree (buyer_character_id, created_at DESC);


--
-- Name: idx_market_partner_trade_record_partner_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_trade_record_partner_def ON public.market_partner_trade_record USING btree (partner_def_id);


--
-- Name: idx_market_partner_trade_record_seller_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_partner_trade_record_seller_time ON public.market_partner_trade_record USING btree (seller_character_id, created_at DESC);


--
-- Name: idx_market_trade_record_buyer_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_trade_record_buyer_time ON public.market_trade_record USING btree (buyer_character_id, created_at DESC);


--
-- Name: idx_market_trade_record_item_def_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_trade_record_item_def_id ON public.market_trade_record USING btree (item_def_id);


--
-- Name: idx_market_trade_record_seller_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_market_trade_record_seller_time ON public.market_trade_record USING btree (seller_character_id, created_at DESC);


--
-- Name: idx_month_card_claim_record_character_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_month_card_claim_record_character_date ON public.month_card_claim_record USING btree (character_id, claim_date DESC);


--
-- Name: idx_month_card_ownership_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_month_card_ownership_character ON public.month_card_ownership USING btree (character_id);


--
-- Name: idx_month_card_ownership_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_month_card_ownership_expire ON public.month_card_ownership USING btree (expire_at);


--
-- Name: idx_online_battle_settlement_battle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_online_battle_settlement_battle ON public.online_battle_settlement_task USING btree (battle_id);


--
-- Name: idx_online_battle_settlement_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_online_battle_settlement_status ON public.online_battle_settlement_task USING btree (status, updated_at);


--
-- Name: idx_partner_fusion_job_character_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_fusion_job_character_time ON public.partner_fusion_job USING btree (character_id, created_at DESC);


--
-- Name: idx_partner_fusion_job_material_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_fusion_job_material_character ON public.partner_fusion_job_material USING btree (character_id, created_at DESC);


--
-- Name: idx_partner_fusion_job_material_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_fusion_job_material_partner ON public.partner_fusion_job_material USING btree (partner_id);


--
-- Name: idx_partner_fusion_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_fusion_job_status ON public.partner_fusion_job USING btree (status, created_at);


--
-- Name: idx_partner_rank_snapshot_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rank_snapshot_character ON public.partner_rank_snapshot USING btree (character_id);


--
-- Name: idx_partner_rank_snapshot_level_power; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rank_snapshot_level_power ON public.partner_rank_snapshot USING btree (level DESC, power DESC, partner_id);


--
-- Name: idx_partner_rank_snapshot_power_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rank_snapshot_power_level ON public.partner_rank_snapshot USING btree (power DESC, level DESC, partner_id);


--
-- Name: idx_partner_rebone_job_character_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rebone_job_character_time ON public.partner_rebone_job USING btree (character_id, created_at DESC);


--
-- Name: idx_partner_rebone_job_partner_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rebone_job_partner_time ON public.partner_rebone_job USING btree (partner_id, created_at DESC);


--
-- Name: idx_partner_rebone_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_rebone_job_status ON public.partner_rebone_job USING btree (status, created_at);


--
-- Name: idx_partner_recruit_job_character_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_recruit_job_character_time ON public.partner_recruit_job USING btree (character_id, created_at DESC);


--
-- Name: idx_partner_recruit_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_recruit_job_status ON public.partner_recruit_job USING btree (status, created_at);


--
-- Name: idx_redeem_code_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redeem_code_status_time ON public.redeem_code USING btree (status, created_at DESC);


--
-- Name: idx_research_points_ledger_character_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_research_points_ledger_character_time ON public.research_points_ledger USING btree (character_id, created_at DESC);


--
-- Name: idx_sect_application_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_application_character ON public.sect_application USING btree (character_id, created_at DESC);


--
-- Name: idx_sect_application_sect_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_application_sect_status ON public.sect_application USING btree (sect_id, status, created_at DESC);


--
-- Name: idx_sect_building_sect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_building_sect ON public.sect_building USING btree (sect_id);


--
-- Name: idx_sect_def_leader; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_def_leader ON public.sect_def USING btree (leader_id);


--
-- Name: idx_sect_def_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_def_name ON public.sect_def USING btree (name);


--
-- Name: idx_sect_log_sect_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_log_sect_time ON public.sect_log USING btree (sect_id, created_at DESC);


--
-- Name: idx_sect_member_char; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_member_char ON public.sect_member USING btree (character_id);


--
-- Name: idx_sect_member_sect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_member_sect ON public.sect_member USING btree (sect_id);


--
-- Name: idx_sect_quest_progress_character; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sect_quest_progress_character ON public.sect_quest_progress USING btree (character_id, status, accepted_at DESC);


--
-- Name: idx_task_def_category_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_def_category_enabled ON public.task_def USING btree (category, enabled, sort_weight DESC);


--
-- Name: idx_team_applications_applicant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_applications_applicant_id ON public.team_applications USING btree (applicant_id);


--
-- Name: idx_team_applications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_applications_status ON public.team_applications USING btree (status);


--
-- Name: idx_team_applications_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_applications_team_id ON public.team_applications USING btree (team_id);


--
-- Name: idx_team_invitations_invitee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_invitee_id ON public.team_invitations USING btree (invitee_id);


--
-- Name: idx_team_invitations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_status ON public.team_invitations USING btree (status);


--
-- Name: idx_team_invitations_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_team_id ON public.team_invitations USING btree (team_id);


--
-- Name: idx_team_members_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_character_id ON public.team_members USING btree (character_id);


--
-- Name: idx_team_members_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_team_id ON public.team_members USING btree (team_id);


--
-- Name: idx_teams_current_map_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_current_map_id ON public.teams USING btree (current_map_id);


--
-- Name: idx_teams_is_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_is_public ON public.teams USING btree (is_public);


--
-- Name: idx_teams_leader_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_leader_id ON public.teams USING btree (leader_id);


--
-- Name: idx_technique_generation_job_character_week; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_technique_generation_job_character_week ON public.technique_generation_job USING btree (character_id, week_key, created_at DESC);


--
-- Name: idx_technique_generation_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_technique_generation_job_status ON public.technique_generation_job USING btree (status, created_at DESC);


--
-- Name: idx_technique_generation_job_unread_result; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_technique_generation_job_unread_result ON public.technique_generation_job USING btree (character_id, status, created_at DESC) WHERE ((((status)::text = 'generated_draft'::text) AND (viewed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('failed'::character varying)::text, ('refunded'::character varying)::text])) AND (failed_viewed_at IS NULL)));


--
-- Name: idx_tower_frozen_monster_snapshot_pool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tower_frozen_monster_snapshot_pool ON public.tower_frozen_monster_snapshot USING btree (frozen_floor_max, kind, realm, monster_def_id);


--
-- Name: partner_fusion_job_material_fusion_job_id_material_order_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX partner_fusion_job_material_fusion_job_id_material_order_key ON public.partner_fusion_job_material USING btree (fusion_job_id, material_order);


--
-- Name: partner_fusion_job_material_fusion_job_id_partner_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX partner_fusion_job_material_fusion_job_id_partner_id_key ON public.partner_fusion_job_material USING btree (fusion_job_id, partner_id);


--
-- Name: redeem_code_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX redeem_code_code_key ON public.redeem_code USING btree (code);


--
-- Name: uniq_redeem_code_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_redeem_code_source ON public.redeem_code USING btree (source_type, source_ref_id);


--
-- Name: uq_bounty_instance_daily_def_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bounty_instance_daily_def_date ON public.bounty_instance USING btree (source_type, refresh_date, bounty_def_id);


--
-- Name: uq_character_global_buff_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_character_global_buff_identity ON public.character_global_buff USING btree (character_id, buff_key, source_type, source_id);


--
-- Name: uq_generated_technique_def_normalized_name_published; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_generated_technique_def_normalized_name_published ON public.generated_technique_def USING btree (normalized_name) WHERE ((is_published = true) AND (normalized_name IS NOT NULL));


--
-- Name: uq_item_instance_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_item_instance_slot ON public.item_instance USING btree (owner_character_id, location, location_slot) WHERE ((owner_character_id IS NOT NULL) AND (location_slot IS NOT NULL) AND ((location)::text = ANY (ARRAY[('bag'::character varying)::text, ('warehouse'::character varying)::text])));


--
-- Name: uq_item_instance_slot_occupied; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_item_instance_slot_occupied ON public.item_instance USING btree (owner_character_id, location, location_slot) WHERE ((owner_character_id IS NOT NULL) AND (location_slot IS NOT NULL) AND ((location)::text = ANY (ARRAY[('bag'::character varying)::text, ('warehouse'::character varying)::text])));


--
-- Name: uq_market_listing_active_item_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_market_listing_active_item_instance ON public.market_listing USING btree (item_instance_id) WHERE ((status)::text = 'active'::text);


--
-- Name: uq_partner_recruit_job_active_character; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_partner_recruit_job_active_character ON public.partner_recruit_job USING btree (character_id) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('generated_draft'::character varying)::text]));


--
-- Name: uq_tower_frozen_monster_snapshot_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tower_frozen_monster_snapshot_key ON public.tower_frozen_monster_snapshot USING btree (frozen_floor_max, kind, realm, monster_def_id);


--
-- Name: users_phone_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_phone_number_key ON public.users USING btree (phone_number);


--
-- Name: arena_battle arena_battle_challenger_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_battle
    ADD CONSTRAINT arena_battle_challenger_character_id_fkey FOREIGN KEY (challenger_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: arena_battle arena_battle_opponent_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_battle
    ADD CONSTRAINT arena_battle_opponent_character_id_fkey FOREIGN KEY (opponent_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: arena_rating arena_rating_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_rating
    ADD CONSTRAINT arena_rating_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: arena_weekly_settlement arena_weekly_settlement_champion_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_weekly_settlement
    ADD CONSTRAINT arena_weekly_settlement_champion_character_id_fkey FOREIGN KEY (champion_character_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: arena_weekly_settlement arena_weekly_settlement_runnerup_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_weekly_settlement
    ADD CONSTRAINT arena_weekly_settlement_runnerup_character_id_fkey FOREIGN KEY (runnerup_character_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: arena_weekly_settlement arena_weekly_settlement_third_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arena_weekly_settlement
    ADD CONSTRAINT arena_weekly_settlement_third_character_id_fkey FOREIGN KEY (third_character_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: battle_pass_claim_record battle_pass_claim_record_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_claim_record
    ADD CONSTRAINT battle_pass_claim_record_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: battle_pass_progress battle_pass_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_progress
    ADD CONSTRAINT battle_pass_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: battle_pass_task_progress battle_pass_task_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_pass_task_progress
    ADD CONSTRAINT battle_pass_task_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: bounty_claim bounty_claim_bounty_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_claim
    ADD CONSTRAINT bounty_claim_bounty_instance_id_fkey FOREIGN KEY (bounty_instance_id) REFERENCES public.bounty_instance(id) ON DELETE CASCADE;


--
-- Name: bounty_claim bounty_claim_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_claim
    ADD CONSTRAINT bounty_claim_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: bounty_instance bounty_instance_published_by_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bounty_instance
    ADD CONSTRAINT bounty_instance_published_by_character_id_fkey FOREIGN KEY (published_by_character_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: character_achievement_battle_state character_achievement_battle_state_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement_battle_state
    ADD CONSTRAINT character_achievement_battle_state_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_achievement character_achievement_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement
    ADD CONSTRAINT character_achievement_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_achievement_points character_achievement_points_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_achievement_points
    ADD CONSTRAINT character_achievement_points_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_feature_unlocks character_feature_unlocks_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_feature_unlocks
    ADD CONSTRAINT character_feature_unlocks_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_global_buff character_global_buff_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_global_buff
    ADD CONSTRAINT character_global_buff_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_insight_progress character_insight_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_insight_progress
    ADD CONSTRAINT character_insight_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_main_quest_progress character_main_quest_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_main_quest_progress
    ADD CONSTRAINT character_main_quest_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_partner character_partner_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner
    ADD CONSTRAINT character_partner_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_partner_skill_policy character_partner_skill_policy_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_skill_policy
    ADD CONSTRAINT character_partner_skill_policy_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.character_partner(id) ON DELETE CASCADE;


--
-- Name: character_partner_technique character_partner_technique_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_partner_technique
    ADD CONSTRAINT character_partner_technique_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.character_partner(id) ON DELETE CASCADE;


--
-- Name: character_rank_snapshot character_rank_snapshot_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_rank_snapshot
    ADD CONSTRAINT character_rank_snapshot_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_research_points character_research_points_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_research_points
    ADD CONSTRAINT character_research_points_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_room_resource_state character_room_resource_state_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_room_resource_state
    ADD CONSTRAINT character_room_resource_state_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_skill_slot character_skill_slot_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_skill_slot
    ADD CONSTRAINT character_skill_slot_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_task_progress character_task_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_task_progress
    ADD CONSTRAINT character_task_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_technique character_technique_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_technique
    ADD CONSTRAINT character_technique_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_title character_title_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_title
    ADD CONSTRAINT character_title_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_tower_progress character_tower_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_tower_progress
    ADD CONSTRAINT character_tower_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_wander_generation_job character_wander_generation_job_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_generation_job
    ADD CONSTRAINT character_wander_generation_job_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_wander_story character_wander_story_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_story
    ADD CONSTRAINT character_wander_story_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_wander_story_episode character_wander_story_episode_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_story_episode
    ADD CONSTRAINT character_wander_story_episode_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_wander_story_episode character_wander_story_episode_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_wander_story_episode
    ADD CONSTRAINT character_wander_story_episode_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.character_wander_story(id) ON DELETE CASCADE;


--
-- Name: characters characters_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: dungeon_entry_count dungeon_entry_count_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_entry_count
    ADD CONSTRAINT dungeon_entry_count_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: dungeon_instance dungeon_instance_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_instance
    ADD CONSTRAINT dungeon_instance_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: dungeon_instance dungeon_instance_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_instance
    ADD CONSTRAINT dungeon_instance_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: dungeon_record dungeon_record_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_record
    ADD CONSTRAINT dungeon_record_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: dungeon_record dungeon_record_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dungeon_record
    ADD CONSTRAINT dungeon_record_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.dungeon_instance(id) ON DELETE SET NULL;


--
-- Name: generated_partner_def generated_partner_def_created_by_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_partner_def
    ADD CONSTRAINT generated_partner_def_created_by_character_id_fkey FOREIGN KEY (created_by_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: generated_technique_def generated_technique_def_created_by_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_technique_def
    ADD CONSTRAINT generated_technique_def_created_by_character_id_fkey FOREIGN KEY (created_by_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: idle_configs idle_configs_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idle_configs
    ADD CONSTRAINT idle_configs_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id);


--
-- Name: idle_sessions idle_sessions_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idle_sessions
    ADD CONSTRAINT idle_sessions_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id);


--
-- Name: inventory inventory_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: item_use_cooldown item_use_cooldown_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_cooldown
    ADD CONSTRAINT item_use_cooldown_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: item_use_count item_use_count_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_use_count
    ADD CONSTRAINT item_use_count_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: market_listing market_listing_buyer_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_buyer_character_id_fkey FOREIGN KEY (buyer_character_id) REFERENCES public.characters(id);


--
-- Name: market_listing market_listing_buyer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_buyer_user_id_fkey FOREIGN KEY (buyer_user_id) REFERENCES public.users(id);


--
-- Name: market_listing market_listing_item_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_item_instance_id_fkey FOREIGN KEY (item_instance_id) REFERENCES public.item_instance(id) ON DELETE SET NULL;


--
-- Name: market_listing market_listing_seller_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_seller_character_id_fkey FOREIGN KEY (seller_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: market_listing market_listing_seller_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_listing
    ADD CONSTRAINT market_listing_seller_user_id_fkey FOREIGN KEY (seller_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: market_trade_record market_trade_record_buyer_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_buyer_character_id_fkey FOREIGN KEY (buyer_character_id) REFERENCES public.characters(id);


--
-- Name: market_trade_record market_trade_record_buyer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_buyer_user_id_fkey FOREIGN KEY (buyer_user_id) REFERENCES public.users(id);


--
-- Name: market_trade_record market_trade_record_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.market_listing(id);


--
-- Name: market_trade_record market_trade_record_seller_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_seller_character_id_fkey FOREIGN KEY (seller_character_id) REFERENCES public.characters(id);


--
-- Name: market_trade_record market_trade_record_seller_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_trade_record
    ADD CONSTRAINT market_trade_record_seller_user_id_fkey FOREIGN KEY (seller_user_id) REFERENCES public.users(id);


--
-- Name: month_card_claim_record month_card_claim_record_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_claim_record
    ADD CONSTRAINT month_card_claim_record_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: month_card_ownership month_card_ownership_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.month_card_ownership
    ADD CONSTRAINT month_card_ownership_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_fusion_job partner_fusion_job_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job
    ADD CONSTRAINT partner_fusion_job_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_fusion_job_material partner_fusion_job_material_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job_material
    ADD CONSTRAINT partner_fusion_job_material_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_fusion_job_material partner_fusion_job_material_fusion_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job_material
    ADD CONSTRAINT partner_fusion_job_material_fusion_job_id_fkey FOREIGN KEY (fusion_job_id) REFERENCES public.partner_fusion_job(id) ON DELETE CASCADE;


--
-- Name: partner_fusion_job partner_fusion_job_preview_partner_def_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_fusion_job
    ADD CONSTRAINT partner_fusion_job_preview_partner_def_id_fkey FOREIGN KEY (preview_partner_def_id) REFERENCES public.generated_partner_def(id) ON DELETE SET NULL;


--
-- Name: partner_rank_snapshot partner_rank_snapshot_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_rank_snapshot
    ADD CONSTRAINT partner_rank_snapshot_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_rank_snapshot partner_rank_snapshot_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_rank_snapshot
    ADD CONSTRAINT partner_rank_snapshot_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.character_partner(id) ON DELETE CASCADE;


--
-- Name: partner_rebone_job partner_rebone_job_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_rebone_job
    ADD CONSTRAINT partner_rebone_job_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_recruit_job partner_recruit_job_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_recruit_job
    ADD CONSTRAINT partner_recruit_job_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: partner_recruit_job partner_recruit_job_preview_partner_def_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_recruit_job
    ADD CONSTRAINT partner_recruit_job_preview_partner_def_id_fkey FOREIGN KEY (preview_partner_def_id) REFERENCES public.generated_partner_def(id) ON DELETE SET NULL;


--
-- Name: research_points_ledger research_points_ledger_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_points_ledger
    ADD CONSTRAINT research_points_ledger_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: sect_application sect_application_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_application
    ADD CONSTRAINT sect_application_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: sect_application sect_application_handled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_application
    ADD CONSTRAINT sect_application_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: sect_application sect_application_sect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_application
    ADD CONSTRAINT sect_application_sect_id_fkey FOREIGN KEY (sect_id) REFERENCES public.sect_def(id) ON DELETE CASCADE;


--
-- Name: sect_building sect_building_sect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_building
    ADD CONSTRAINT sect_building_sect_id_fkey FOREIGN KEY (sect_id) REFERENCES public.sect_def(id) ON DELETE CASCADE;


--
-- Name: sect_def sect_def_leader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_def
    ADD CONSTRAINT sect_def_leader_id_fkey FOREIGN KEY (leader_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: sect_log sect_log_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_log
    ADD CONSTRAINT sect_log_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: sect_log sect_log_sect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_log
    ADD CONSTRAINT sect_log_sect_id_fkey FOREIGN KEY (sect_id) REFERENCES public.sect_def(id) ON DELETE CASCADE;


--
-- Name: sect_log sect_log_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_log
    ADD CONSTRAINT sect_log_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.characters(id) ON DELETE SET NULL;


--
-- Name: sect_member sect_member_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_member
    ADD CONSTRAINT sect_member_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: sect_member sect_member_sect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_member
    ADD CONSTRAINT sect_member_sect_id_fkey FOREIGN KEY (sect_id) REFERENCES public.sect_def(id) ON DELETE CASCADE;


--
-- Name: sect_quest_progress sect_quest_progress_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sect_quest_progress
    ADD CONSTRAINT sect_quest_progress_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: sign_in_records sign_in_records_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_records
    ADD CONSTRAINT sign_in_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: team_applications team_applications_applicant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_applications
    ADD CONSTRAINT team_applications_applicant_id_fkey FOREIGN KEY (applicant_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: team_applications team_applications_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_applications
    ADD CONSTRAINT team_applications_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_invitations team_invitations_invitee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: team_invitations team_invitations_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: team_invitations team_invitations_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: teams teams_leader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_leader_id_fkey FOREIGN KEY (leader_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: technique_generation_job technique_generation_job_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technique_generation_job
    ADD CONSTRAINT technique_generation_job_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
