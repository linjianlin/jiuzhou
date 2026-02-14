import { query } from '../config/database.js';

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
COMMENT ON COLUMN character_main_quest_progress.current_chapter_id IS '当前章节ID（静态配置ID）';
COMMENT ON COLUMN character_main_quest_progress.current_section_id IS '当前任务节ID（静态配置ID）';
COMMENT ON COLUMN character_main_quest_progress.section_status IS '节状态：not_started/dialogue/objectives/turnin/completed';
COMMENT ON COLUMN character_main_quest_progress.objectives_progress IS '目标进度';
COMMENT ON COLUMN character_main_quest_progress.dialogue_state IS '对话状态';
COMMENT ON COLUMN character_main_quest_progress.completed_chapters IS '已完成章节列表';
COMMENT ON COLUMN character_main_quest_progress.completed_sections IS '已完成任务节列表';
COMMENT ON COLUMN character_main_quest_progress.tracked IS '是否追踪主线任务';
`;

export const initMainQuestTables = async (): Promise<void> => {
  await query(characterMainQuestProgressTableSQL);
  console.log('  → 主线章节/任务节/对话定义改为静态JSON加载，跳过建表');

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
