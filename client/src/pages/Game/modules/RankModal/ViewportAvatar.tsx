/**
 * 排行榜可视区头像组件。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为排行榜弹窗提供“进入滚动可视区附近后再挂真实图片地址”的统一头像入口，覆盖玩家头像与伙伴头像两类展示。
 * 2. 做什么：按滚动根节点共享 `IntersectionObserver`，避免每个头像都单独创建 observer，减少列表滚动时的监听开销。
 * 3. 不做什么：不解析头像 URL，不决定头像尺寸，不改动排行榜行布局，也不处理列表数据请求。
 *
 * 输入 / 输出：
 * - 输入：滚动容器节点 `scrollRoot`、头像唯一 key、图片地址、展示文案与尺寸 / 类名。
 * - 输出：可直接嵌入 RankModal 身份块的头像节点；进入可视区前只保留等尺寸占位，进入后再挂真实 `src`。
 *
 * 数据流 / 状态流：
 * RankModal 计算并传入头像地址与滚动容器 -> 本模块在占位节点上注册共享 observer ->
 * 节点进入 `.rank-pane-body` 可视区附近时写入模块级“已曝光”缓存 -> 对应头像组件切换为真实图片渲染。
 *
 * 复用设计说明：
 * 1. 玩家头像与伙伴头像共用同一套 observer 与曝光缓存，避免在 RankModal 页面内重复维护两份懒加载状态。
 * 2. 可视区判断、预加载边距和清理逻辑全部收口在本模块，后续若排行榜新增更多头像位，只需要继续复用当前组件。
 * 3. 已曝光缓存放在模块级，滚动回退时不会重复卸载重挂真实 `src`，减少重复网络请求与状态抖动。
 *
 * 关键边界条件与坑点：
 * 1. 只有当 `scrollRoot` 与占位节点都就绪时才注册 observer，否则不能提前假定节点已可见。
 * 2. observer 必须按滚动根节点共享并在最后一个监听节点移除时断开，否则弹窗销毁后会残留无效观察器。
 */
import { UserOutlined } from '@ant-design/icons';
import { Avatar } from 'antd';
import { useEffect, useRef, useState, type RefObject } from 'react';

interface RankViewportAvatarBaseProps {
  avatarKey: string;
  scrollRoot: HTMLElement | null;
}

interface RankViewportPlayerAvatarProps extends RankViewportAvatarBaseProps {
  className: string;
  size: number;
  src?: string;
}

interface RankViewportPartnerAvatarProps extends RankViewportAvatarBaseProps {
  alt: string;
  className: string;
  src: string;
}

interface SharedObserverBucket {
  callbacks: Map<Element, () => void>;
  observer: IntersectionObserver;
}

const AVATAR_PRELOAD_ROOT_MARGIN = '120px 0px';
const AVATAR_INTERSECTION_THRESHOLD = 0.01;
const loadedAvatarKeys = new Set<string>();
const observerBuckets = new WeakMap<HTMLElement, SharedObserverBucket>();

const getObserverBucket = (root: HTMLElement): SharedObserverBucket => {
  const existingBucket = observerBuckets.get(root);
  if (existingBucket) return existingBucket;

  const callbacks = new Map<Element, () => void>();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const callback = callbacks.get(entry.target);
      if (!callback) return;
      callbacks.delete(entry.target);
      observer.unobserve(entry.target);
      callback();
    });
  }, {
    root,
    rootMargin: AVATAR_PRELOAD_ROOT_MARGIN,
    threshold: AVATAR_INTERSECTION_THRESHOLD,
  });

  const nextBucket: SharedObserverBucket = {
    callbacks,
    observer,
  };
  observerBuckets.set(root, nextBucket);
  return nextBucket;
};

const observeAvatarOnce = (
  root: HTMLElement,
  target: Element,
  onVisible: () => void,
): (() => void) => {
  const bucket = getObserverBucket(root);
  bucket.callbacks.set(target, onVisible);
  bucket.observer.observe(target);

  return () => {
    bucket.callbacks.delete(target);
    bucket.observer.unobserve(target);

    if (bucket.callbacks.size !== 0) return;
    bucket.observer.disconnect();
    observerBuckets.delete(root);
  };
};

const useViewportAvatarReady = (
  avatarKey: string,
  scrollRoot: HTMLElement | null,
  enabled: boolean,
): {
  isReady: boolean;
  targetRef: RefObject<HTMLSpanElement | null>;
} => {
  const targetRef = useRef<HTMLSpanElement | null>(null);
  const [isReady, setIsReady] = useState<boolean>(() => !enabled || loadedAvatarKeys.has(avatarKey));

  useEffect(() => {
    if (!enabled) {
      setIsReady(true);
      return;
    }

    if (loadedAvatarKeys.has(avatarKey)) {
      setIsReady(true);
      return;
    }

    setIsReady(false);
  }, [avatarKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (isReady) return;
    if (!scrollRoot) return;

    const target = targetRef.current;
    if (!target) return;

    return observeAvatarOnce(scrollRoot, target, () => {
      loadedAvatarKeys.add(avatarKey);
      setIsReady(true);
    });
  }, [avatarKey, enabled, isReady, scrollRoot]);

  return {
    isReady,
    targetRef,
  };
};

export const RankViewportPlayerAvatar: React.FC<RankViewportPlayerAvatarProps> = ({
  avatarKey,
  className,
  scrollRoot,
  size,
  src,
}) => {
  const { isReady, targetRef } = useViewportAvatarReady(avatarKey, scrollRoot, Boolean(src));

  return (
    <span ref={targetRef} className="rank-viewport-avatar-anchor">
      <Avatar
        className={className}
        size={size}
        src={isReady ? src : undefined}
        icon={<UserOutlined />}
      />
    </span>
  );
};

export const RankViewportPartnerAvatar: React.FC<RankViewportPartnerAvatarProps> = ({
  alt,
  avatarKey,
  className,
  scrollRoot,
  src,
}) => {
  const { isReady, targetRef } = useViewportAvatarReady(avatarKey, scrollRoot, true);

  return (
    <span ref={targetRef} className="rank-viewport-avatar-anchor">
      {isReady ? (
        <img
          className={className}
          src={src}
          alt={alt}
        />
      ) : (
        <span
          aria-hidden="true"
          className={`${className} rank-partner-avatar--placeholder`}
        />
      )}
    </span>
  );
};
