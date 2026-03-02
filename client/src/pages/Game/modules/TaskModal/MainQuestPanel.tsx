import { App, Button, Tag, Progress, Spin, Switch } from 'antd';
import { BookOutlined, CheckCircleOutlined, RightOutlined, TrophyOutlined, AimOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import {
  getMainQuestProgress,
  getChapterList,
  getSectionList,
  completeSection,
  setMainQuestTracked,
  type MainQuestProgressDto,
  type ChapterDto,
  type SectionDto,
} from '../../../../services/mainQuestApi';
import { resolveIconUrl } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import './MainQuestPanel.scss';

interface MainQuestPanelProps {
  onClose?: () => void;
  onTrackChange?: () => void;
}

type ViewMode = 'progress' | 'chapters' | 'sections';

const resolveRewardIcon = resolveIconUrl;

const MainQuestPanel: React.FC<MainQuestPanelProps> = ({ onTrackChange }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('progress');
  const [progress, setProgress] = useState<MainQuestProgressDto | null>(null);
  const [chapters, setChapters] = useState<ChapterDto[]>([]);
  const [sections, setSections] = useState<SectionDto[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  const [trackLoading, setTrackLoading] = useState(false);

  const appendSystemChat = useCallback((content: string) => {
    const text = String(content || '').trim();
    if (!text) return;
    window.dispatchEvent(
      new CustomEvent('chat:append', {
        detail: {
          channel: 'system',
          content: text,
          senderName: '系统',
          senderTitle: '',
          timestamp: Date.now(),
        },
      }),
    );
  }, []);

  // 加载主线进度
  const loadProgress = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMainQuestProgress();
      if (res?.success && res.data) {
        setProgress(res.data);
      }
    } catch {
      void 0;
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 加载章节列表
  const loadChapters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getChapterList();
      if (res?.success && res.data) {
        setChapters(res.data.chapters || []);
      }
    } catch {
      void 0;
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 加载任务节列表
  const loadSections = useCallback(async (chapterId: string) => {
    setLoading(true);
    try {
      const res = await getSectionList(chapterId);
      if (res?.success && res.data) {
        setSections(res.data.sections || []);
      }
    } catch {
      void 0;
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 切换追踪状态
  const handleToggleTrack = useCallback(async (tracked: boolean) => {
    setTrackLoading(true);
    try {
      const res = await setMainQuestTracked(tracked);
      if (res?.success) {
        setProgress((prev) => prev ? { ...prev, tracked } : null);
        message.success(tracked ? '已追踪主线任务' : '已取消追踪');
        onTrackChange?.();
        window.dispatchEvent(new Event('room:objects:changed'));
      } else {
        void 0;
      }
    } catch {
      void 0;
    } finally {
      setTrackLoading(false);
    }
  }, [message, onTrackChange]);

  // 完成任务节
  const handleCompleteSection = useCallback(async () => {
    setLoading(true);
    try {
      const res = await completeSection();
      if (res?.success && res.data) {
        const rewards = res.data.rewards || [];
        const rewardTexts: string[] = [];
        for (const r of rewards) {
          const rr = r as {
            type?: string;
            amount?: number;
            itemDefId?: string;
            quantity?: number;
            itemName?: string;
            techniqueId?: string;
            techniqueName?: string;
          };
          if (rr.type === 'exp') rewardTexts.push(`经验 +${rr.amount}`);
          if (rr.type === 'silver') rewardTexts.push(`银两 +${rr.amount}`);
          if (rr.type === 'spirit_stones') rewardTexts.push(`灵石 +${rr.amount}`);
          if (rr.type === 'item') {
            const name = (rr.itemName || rr.itemDefId || '').trim();
            const qty = rr.quantity || 1;
            rewardTexts.push(name ? `物品「${name}」×${qty}` : `物品 ×${qty}`);
          }
          if (rr.type === 'technique') {
            const name = (rr.techniqueName || rr.techniqueId || '').trim();
            rewardTexts.push(name ? `功法「${name}」` : '功法');
          }
        }
        message.success('任务完成！');
        if (rewardTexts.length > 0) {
          appendSystemChat(`【主线】获得奖励：${rewardTexts.join('，')}`);
        }
        if (res.data.chapterCompleted) {
          appendSystemChat('【主线】恭喜完成本章！');
        }
        await loadProgress();
      } else {
        void 0;
      }
    } catch {
      void 0;
    } finally {
      setLoading(false);
    }
  }, [appendSystemChat, loadProgress, message]);

  useEffect(() => {
    loadProgress();
  }, [loadProgress]);

  // 生成任务指引文本
  const getTaskGuidance = (section: SectionDto): string => {
    if (section.status === 'not_started' || section.status === 'dialogue') {
      if (section.npcId) {
        return `前往与NPC对话开始任务`;
      }
      return '与相关NPC对话开始任务';
    }
    if (section.status === 'objectives') {
      const incomplete = section.objectives.filter((o) => o.done < o.target);
      if (incomplete.length > 0) {
        return incomplete.map((o) => o.text).join('；');
      }
      return '完成任务目标';
    }
    if (section.status === 'turnin') {
      if (section.npcId) {
        return `返回与NPC对话交付任务`;
      }
      return '返回交付任务';
    }
    return '';
  };

  // 渲染当前进度视图
  const renderProgressView = () => {
    if (!progress) {
      return <div className="mq-empty">暂无主线进度</div>;
    }

    const { currentChapter, currentSection, tracked } = progress;

    return (
      <div className="mq-progress-view">
        {currentChapter && (
          <div className="mq-chapter-card">
            <div className="mq-chapter-header">
              <BookOutlined className="mq-chapter-icon" />
              <div className="mq-chapter-info">
                <div className="mq-chapter-num">第{currentChapter.chapterNum}章</div>
                <div className="mq-chapter-name">{currentChapter.name}</div>
              </div>
            </div>
            <div className="mq-chapter-bg">{currentChapter.background}</div>
          </div>
        )}

        {currentSection && (
          <div className="mq-section-card">
            <div className="mq-section-header">
              <div className="mq-section-title">
                <span className="mq-section-num">第{currentSection.sectionNum}节</span>
                <span className="mq-section-name">{currentSection.name}</span>
              </div>
              <Tag color={
                currentSection.status === 'completed' ? 'green' :
                currentSection.status === 'turnin' ? 'gold' :
                currentSection.status === 'objectives' ? 'blue' :
                currentSection.status === 'dialogue' ? 'purple' : 'default'
              }>
                {currentSection.status === 'completed' ? '已完成' :
                 currentSection.status === 'turnin' ? '可交付' :
                 currentSection.status === 'objectives' ? '进行中' :
                 currentSection.status === 'dialogue' ? '对话中' : '未开始'}
              </Tag>
            </div>
            <div className="mq-section-desc">{currentSection.description}</div>

            {/* 任务指引 */}
            {currentSection.status !== 'completed' && (
              <div className="mq-guidance">
                <EnvironmentOutlined className="mq-guidance-icon" />
                <span className="mq-guidance-text">{getTaskGuidance(currentSection)}</span>
              </div>
            )}

            {currentSection.objectives.length > 0 && (
              <div className="mq-objectives">
                <div className="mq-objectives-title">任务目标</div>
                {currentSection.objectives.map((obj) => (
                  <div key={obj.id} className="mq-objective">
                    <div className="mq-objective-text">{obj.text}</div>
                    <div className="mq-objective-progress">
                      <Progress
                        percent={Math.min(100, Math.round((obj.done / obj.target) * 100))}
                        size="small"
                        format={() => `${obj.done}/${obj.target}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {currentSection.rewards && (
              <div className="mq-rewards">
                <div className="mq-rewards-title">任务奖励</div>
                <div className="mq-rewards-list">
                  {currentSection.rewards.exp && (
                    <div className="mq-reward-item">
                      <span className="mq-reward-label">经验</span>
                      <span className="mq-reward-value">+{currentSection.rewards.exp}</span>
                    </div>
                  )}
                  {currentSection.rewards.silver && (
                    <div className="mq-reward-item">
                      <img src={tongqianIcon} alt="银两" className="mq-reward-icon" />
                      <span className="mq-reward-value">+{currentSection.rewards.silver}</span>
                    </div>
                  )}
                  {currentSection.rewards.spirit_stones && (
                    <div className="mq-reward-item">
                      <img src={lingshiIcon} alt="灵石" className="mq-reward-icon" />
                      <span className="mq-reward-value">+{currentSection.rewards.spirit_stones}</span>
                    </div>
                  )}
                  {currentSection.rewards.items_detail?.map((it) => (
                    <div key={it.item_def_id} className="mq-reward-item">
                      <img src={resolveRewardIcon(it.icon)} alt={it.name || it.item_def_id} className="mq-reward-icon" />
                      <span className="mq-reward-value">
                        {(it.name || it.item_def_id) ?? '物品'} ×{it.quantity}
                      </span>
                    </div>
                  ))}
                  {currentSection.rewards.techniques_detail?.map((t) => (
                    <div key={t.id} className="mq-reward-item">
                      {t.icon ? <img src={resolveRewardIcon(t.icon)} alt={t.name || t.id} className="mq-reward-icon" /> : null}
                      <span className="mq-reward-label">功法</span>
                      <span className="mq-reward-value">{t.name || t.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mq-section-actions">
              {/* 追踪按钮 */}
              {currentSection.status !== 'completed' && (
                <div className="mq-track-row">
                  <AimOutlined className={`mq-track-icon ${tracked ? 'active' : ''}`} />
                  <span className="mq-track-label">追踪任务</span>
                  <Switch
                    checked={tracked}
                    onChange={handleToggleTrack}
                    loading={trackLoading}
                    size="small"
                  />
                </div>
              )}

              {currentSection.status === 'turnin' && (
                <Button
                  type="primary"
                  onClick={handleCompleteSection}
                  loading={loading}
                  icon={<TrophyOutlined />}
                >
                  完成任务
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="mq-nav-actions">
          <Button onClick={() => { loadChapters(); setViewMode('chapters'); }}>
            查看全部章节
          </Button>
        </div>
      </div>
    );
  };

  // 渲染章节列表
  const renderChaptersView = () => (
    <div className="mq-chapters-view">
      <div className="mq-view-header">
        <Button onClick={() => setViewMode('progress')}>← 返回</Button>
        <div className="mq-view-title">全部章节</div>
      </div>
      <div className="mq-chapters-list">
        {chapters.map((chapter) => (
          <div
            key={chapter.id}
            className={`mq-chapter-item ${chapter.isCompleted ? 'completed' : ''}`}
            onClick={() => {
              setSelectedChapterId(chapter.id);
              loadSections(chapter.id);
              setViewMode('sections');
            }}
          >
            <div className="mq-chapter-item-left">
              <div className="mq-chapter-item-num">第{chapter.chapterNum}章</div>
              <div className="mq-chapter-item-name">{chapter.name}</div>
              <div className="mq-chapter-item-desc">{chapter.description}</div>
            </div>
            <div className="mq-chapter-item-right">
              {chapter.isCompleted ? (
                <CheckCircleOutlined className="mq-completed-icon" />
              ) : (
                <RightOutlined />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // 渲染任务节列表
  const renderSectionsView = () => {
    const chapter = chapters.find((c) => c.id === selectedChapterId);
    return (
      <div className="mq-sections-view">
        <div className="mq-view-header">
          <Button onClick={() => setViewMode('chapters')}>← 返回</Button>
          <div className="mq-view-title">{chapter ? `第${chapter.chapterNum}章 ${chapter.name}` : '任务节'}</div>
        </div>
        <div className="mq-sections-list">
          {sections.map((section) => (
            <div key={section.id} className={`mq-section-item ${section.status}`}>
              <div className="mq-section-item-header">
                <div className="mq-section-item-num">第{section.sectionNum}节</div>
                <div className="mq-section-item-name">{section.name}</div>
                <Tag color={
                  section.status === 'completed' ? 'green' :
                  section.status === 'turnin' ? 'gold' :
                  section.status === 'objectives' ? 'blue' : 'default'
                }>
                  {section.status === 'completed' ? '已完成' :
                   section.status === 'turnin' ? '可交付' :
                   section.status === 'objectives' ? '进行中' : '未开始'}
                </Tag>
              </div>
              <div className="mq-section-item-brief">{section.brief}</div>
              {section.objectives.length > 0 && (
                <div className="mq-section-item-objectives">
                  {section.objectives.map((obj) => (
                    <div key={obj.id} className="mq-mini-objective">
                      <span>{obj.text}</span>
                      <span>{obj.done}/{obj.target}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="main-quest-panel">
      <Spin spinning={loading}>
        {viewMode === 'progress' && renderProgressView()}
        {viewMode === 'chapters' && renderChaptersView()}
        {viewMode === 'sections' && renderSectionsView()}
      </Spin>
    </div>
  );
};

export default MainQuestPanel;
