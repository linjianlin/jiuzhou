import { query } from '../config/database.js';

const mainQuestChapterTableSQL = `
CREATE TABLE IF NOT EXISTS main_quest_chapter (
  id VARCHAR(64) PRIMARY KEY,
  chapter_num INT NOT NULL,
  name VARCHAR(64) NOT NULL,
  description TEXT,
  background TEXT,
  min_realm VARCHAR(64) DEFAULT '凡人',
  chapter_rewards JSONB DEFAULT '{}',
  unlock_features JSONB DEFAULT '[]',
  sort_weight INT DEFAULT 0,
  enabled BOOLEAN DEFAULT TRUE,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE main_quest_chapter IS '主线章节定义表';
COMMENT ON COLUMN main_quest_chapter.id IS '章节ID';
COMMENT ON COLUMN main_quest_chapter.chapter_num IS '章节序号';
COMMENT ON COLUMN main_quest_chapter.name IS '章节名称';
COMMENT ON COLUMN main_quest_chapter.description IS '章节描述';
COMMENT ON COLUMN main_quest_chapter.background IS '章节背景故事';
COMMENT ON COLUMN main_quest_chapter.min_realm IS '最低境界要求';
COMMENT ON COLUMN main_quest_chapter.chapter_rewards IS '章节完成奖励';
COMMENT ON COLUMN main_quest_chapter.unlock_features IS '解锁功能列表';

CREATE INDEX IF NOT EXISTS idx_main_quest_chapter_num ON main_quest_chapter(chapter_num);
`;

const mainQuestSectionTableSQL = `
CREATE TABLE IF NOT EXISTS main_quest_section (
  id VARCHAR(64) PRIMARY KEY,
  chapter_id VARCHAR(64) NOT NULL REFERENCES main_quest_chapter(id) ON DELETE CASCADE,
  section_num INT NOT NULL,
  name VARCHAR(64) NOT NULL,
  description TEXT,
  brief VARCHAR(256),
  npc_id VARCHAR(64),
  map_id VARCHAR(64),
  room_id VARCHAR(64),
  min_realm VARCHAR(64),
  dialogue_id VARCHAR(64),
  dialogue_complete_id VARCHAR(64),
  objectives JSONB DEFAULT '[]',
  rewards JSONB DEFAULT '{}',
  auto_accept BOOLEAN DEFAULT TRUE,
  auto_complete BOOLEAN DEFAULT FALSE,
  is_chapter_final BOOLEAN DEFAULT FALSE,
  sort_weight INT DEFAULT 0,
  enabled BOOLEAN DEFAULT TRUE,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE main_quest_section IS '主线任务节定义表';
COMMENT ON COLUMN main_quest_section.id IS '任务节ID';
COMMENT ON COLUMN main_quest_section.chapter_id IS '所属章节ID';
COMMENT ON COLUMN main_quest_section.section_num IS '节序号';
COMMENT ON COLUMN main_quest_section.name IS '任务名称';
COMMENT ON COLUMN main_quest_section.description IS '任务描述';
COMMENT ON COLUMN main_quest_section.brief IS '任务简述';
COMMENT ON COLUMN main_quest_section.npc_id IS '关联NPC（交互入口/交付）';
COMMENT ON COLUMN main_quest_section.map_id IS '关联地图ID';
COMMENT ON COLUMN main_quest_section.room_id IS '关联房间ID';
COMMENT ON COLUMN main_quest_section.min_realm IS '最低境界要求';
COMMENT ON COLUMN main_quest_section.dialogue_id IS '开始对话ID';
COMMENT ON COLUMN main_quest_section.dialogue_complete_id IS '完成对话ID';
COMMENT ON COLUMN main_quest_section.objectives IS '任务目标列表';
COMMENT ON COLUMN main_quest_section.rewards IS '任务奖励';
COMMENT ON COLUMN main_quest_section.auto_accept IS '是否自动接取';
COMMENT ON COLUMN main_quest_section.auto_complete IS '是否自动完成';
COMMENT ON COLUMN main_quest_section.is_chapter_final IS '是否章节终章';

CREATE INDEX IF NOT EXISTS idx_main_quest_section_chapter ON main_quest_section(chapter_id, section_num);
`;

const dialogueDefTableSQL = `
CREATE TABLE IF NOT EXISTS dialogue_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  nodes JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN DEFAULT TRUE,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE dialogue_def IS '对话定义表';
COMMENT ON COLUMN dialogue_def.id IS '对话ID';
COMMENT ON COLUMN dialogue_def.name IS '对话名称';
COMMENT ON COLUMN dialogue_def.nodes IS '对话节点列表';
`;

const characterMainQuestProgressTableSQL = `
CREATE TABLE IF NOT EXISTS character_main_quest_progress (
  character_id INT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  current_chapter_id VARCHAR(64),
  current_section_id VARCHAR(64),
  section_status VARCHAR(16) DEFAULT 'not_started',
  objectives_progress JSONB DEFAULT '{}',
  dialogue_state JSONB DEFAULT '{}',
  completed_chapters JSONB DEFAULT '[]',
  completed_sections JSONB DEFAULT '[]',
  tracked BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE character_main_quest_progress IS '角色主线进度表';
COMMENT ON COLUMN character_main_quest_progress.character_id IS '角色ID';
COMMENT ON COLUMN character_main_quest_progress.current_chapter_id IS '当前章节ID';
COMMENT ON COLUMN character_main_quest_progress.current_section_id IS '当前任务节ID';
COMMENT ON COLUMN character_main_quest_progress.section_status IS '节状态：not_started/dialogue/objectives/turnin/completed';
COMMENT ON COLUMN character_main_quest_progress.objectives_progress IS '目标进度';
COMMENT ON COLUMN character_main_quest_progress.dialogue_state IS '对话状态';
COMMENT ON COLUMN character_main_quest_progress.completed_chapters IS '已完成章节列表';
COMMENT ON COLUMN character_main_quest_progress.completed_sections IS '已完成任务节列表';
COMMENT ON COLUMN character_main_quest_progress.tracked IS '是否追踪主线任务';
`;

export const initMainQuestTables = async (): Promise<void> => {
  await query(mainQuestChapterTableSQL);
  await query(mainQuestSectionTableSQL);
  await query(dialogueDefTableSQL);
  await query(characterMainQuestProgressTableSQL);

  await query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'character_main_quest_progress' AND column_name = 'tracked'
      ) THEN
        EXECUTE $$ALTER TABLE character_main_quest_progress ADD COLUMN tracked BOOLEAN DEFAULT TRUE$$;
      END IF;
    END
    $do$;
  `);

  await query(`
    DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'character_main_quest_progress' AND column_name = 'tracked'
      ) THEN
        EXECUTE $$COMMENT ON COLUMN character_main_quest_progress.tracked IS '是否追踪主线任务'$$;
      END IF;
    END
    $do$;
  `);

  console.log('✓ 主线任务系统表检测完成');
};

