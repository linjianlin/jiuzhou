/**
 * 作用：
 * - 提供稳定的 NPC 对话弹窗外壳，固定消息时间线和底部动作区，避免请求中整块内容被替换导致闪烁。
 * - 不负责业务分支判断；页面只需把对白与操作区传入即可复用。
 *
 * 输入/输出：
 * - 输入：弹窗开关、NPC 名称、对白时间线、加载状态、忙碌提示、动作区内容、关闭回调。
 * - 输出：完整可渲染的 Modal UI。
 *
 * 数据流/状态流：
 * - `Game/index.tsx` 维护消息与阶段 -> 本组件渲染时间线 -> 新消息/状态变化时自动滚动到底部。
 *
 * 关键边界条件与坑点：
 * - 首次进入且还没有对白时，只渲染骨架占位，不覆盖后续已存在的消息列表。
 * - 自动滚动只依赖消息长度和忙碌提示，避免因为对象引用变化频繁跳动视口。
 */
import { Modal } from 'antd';
import { memo, useEffect, useRef, type ReactNode } from 'react';
import { useIsMobile } from '../../shared/responsive';
import type { NpcDialogueEntry } from './shared';
import './index.scss';

interface NpcTalkModalProps {
  open: boolean;
  npcName?: string;
  dialogue: NpcDialogueEntry[];
  loading: boolean;
  busyText: string | null;
  children: ReactNode;
  onClose: () => void;
}

const SKELETON_ROW_KEYS = ['npc', 'player', 'npc'] as const;

const NpcTalkModal = memo(({ open, npcName, dialogue, loading, busyText, children, onClose }: NpcTalkModalProps) => {
  const isMobile = useIsMobile();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const showSkeleton = loading && dialogue.length === 0;

  useEffect(() => {
    if (!open) {
      return;
    }
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: dialogue.length > 0 ? 'smooth' : 'auto',
    });
  }, [busyText, dialogue.length, open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={isMobile ? 'calc(100vw - 24px)' : 720}
      title={npcName ? `与「${npcName}」对话` : '对话'}
      destroyOnHidden
      maskClosable
      className="npc-talk-modal"
    >
      <div className="npc-talk-shell">
        <div ref={transcriptRef} className="npc-talk-transcript">
          {showSkeleton ? (
            <div className="npc-talk-skeleton-list" aria-hidden="true">
              {SKELETON_ROW_KEYS.map((rowKey, index) => (
                <div key={`${rowKey}-${index}`} className={`npc-talk-skeleton-row is-${rowKey}`}>
                  <div className="npc-talk-skeleton-bubble" />
                </div>
              ))}
            </div>
          ) : dialogue.length > 0 ? (
            dialogue.map((entry) => (
              <div key={entry.id} className={`npc-talk-row is-${entry.role}`}>
                <div className="npc-talk-bubble">
                  {entry.speaker ? <div className="npc-talk-speaker">{entry.speaker}</div> : null}
                  <div className="npc-talk-text">{entry.text}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="npc-talk-empty">暂无对白</div>
          )}
          {busyText ? (
            <div className="npc-talk-status">
              <span className="npc-talk-status-dot" />
              <span>{busyText}</span>
            </div>
          ) : null}
        </div>

        <div className="npc-talk-actions">
          <div className="npc-talk-actions-title">下一步</div>
          {children}
        </div>
      </div>
    </Modal>
  );
});

NpcTalkModal.displayName = 'NpcTalkModal';

export default NpcTalkModal;
