/**
 * 功法书预览浮层。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承载“按功法 ID 打开的功法书预览”在桌面端弹窗与移动端抽屉中的展示壳层。
 * 2. 做什么：把 loading、标题和详情正文收敛到一个入口，避免聊天等调用方各自拼一套弹层。
 * 3. 不做什么：不发起详情请求，也不决定哪些入口可以打开功法预览。
 *
 * 输入 / 输出：
 * - 输入：功法书预览视图、加载态、当前端形态，以及关闭回调。
 * - 输出：一个 `Modal` 或 `Drawer` 节点；当既不加载也无详情时返回 `null`。
 *
 * 数据流 / 状态流：
 * `useTechniquePreview` -> 本组件 -> `TechniqueBookPreviewPanel`。
 *
 * 复用设计说明：
 * 1. 详情正文继续完全复用共享 `TechniqueBookPreviewPanel`，避免聊天广播再分叉出独立详情结构。
 * 2. 桌面与移动端共用同一份详情数据，后续其他只拿到功法 ID 的入口也可以直接复用当前浮层。
 * 3. 加载骨架屏和标题在这里统一，调用方只处理“打开哪门功法”，不再关心弹层细节。
 *
 * 关键边界条件与坑点：
 * 1. 关闭时必须同时支持“详情为空但仍处于加载中”的场景，否则点击后用户会看到弹层瞬间闪退。
 * 2. 移动端必须明确切到 `TechniqueBookPreviewPanel` 的移动布局，不能依赖窗口宽度在内容层再次猜测。
 */
import { Drawer, Modal, Skeleton } from 'antd';
import TechniqueBookPreviewPanel from './TechniqueBookPreviewPanel';
import type { TechniqueBookPreviewView } from './techniqueBookPreview';

interface TechniquePreviewOverlayProps {
  detail: TechniqueBookPreviewView | null;
  loading: boolean;
  isMobile: boolean;
  onClose: () => void;
}

const TechniquePreviewOverlay = ({
  detail,
  loading,
  isMobile,
  onClose,
}: TechniquePreviewOverlayProps) => {
  if (!loading && !detail) {
    return null;
  }

  const title = detail?.name ?? '功法书详情';
  const content = loading
    ? <Skeleton active paragraph={{ rows: isMobile ? 6 : 8 }} />
    : <TechniqueBookPreviewPanel detail={detail} isMobile={isMobile} />;

  if (isMobile) {
    return (
      <Drawer
        title={title}
        placement="bottom"
        open
        onClose={onClose}
        height="62dvh"
        destroyOnHidden
        className="tech-submodal tech-detail-submodal"
        styles={{ body: { padding: '10px 12px 12px' } }}
      >
        {content}
      </Drawer>
    );
  }

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      title={title}
      centered
      width="min(720px, calc(100vw - 16px))"
      className="tech-submodal tech-detail-submodal"
      destroyOnHidden
    >
      {content}
    </Modal>
  );
};

export default TechniquePreviewOverlay;
