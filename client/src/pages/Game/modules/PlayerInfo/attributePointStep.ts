/**
 * 属性加减档位共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护角色属性面板的档位选项、操作标签和按钮可用性判断，避免 `PlayerInfo` 把 `1 / 5 / 10`、加减禁用条件散落在多个按钮里。
 * 2. 做什么：作为基础属性区唯一的档位数据源，供加点和减点同时复用。
 * 3. 不做什么：不负责发送接口请求，也不处理角色数据刷新。
 *
 * 输入/输出：
 * - 输入：操作类型、当前选中档位、角色剩余属性点、目标属性当前值。
 * - 输出：统一档位列表、按钮无障碍标签，以及当前操作是否允许执行。
 *
 * 数据流/状态流：
 * PlayerInfo 读取共享档位配置 -> 生成档位切换按钮 / 判断 +/- 按钮禁用态 -> 仅在允许时调用属性接口。
 *
 * 关键边界条件与坑点：
 * 1. 同一档位必须同时作用于增加和减少，不能分别维护两套选项，否则产品继续扩档时很容易只改一边。
 * 2. 前端这里直接阻止超额操作，减少后端收到“剩余点数不够”或“属性值不足”的无效请求；这不是兜底，而是当前交互本身的一部分。
 */

export const ATTRIBUTE_POINT_STEP_OPTIONS = [1, 5, 10] as const;

export type AttributePointStep = (typeof ATTRIBUTE_POINT_STEP_OPTIONS)[number];
export type AttributePointAction = 'add' | 'remove';

export const DEFAULT_ATTRIBUTE_POINT_STEP: AttributePointStep = ATTRIBUTE_POINT_STEP_OPTIONS[0];

interface AttributePointStepAvailabilityInput {
  action: AttributePointAction;
  step: AttributePointStep;
  attributePoints: number;
  currentValue: number;
}

export const canAdjustAttributePointByStep = ({
  action,
  step,
  attributePoints,
  currentValue,
}: AttributePointStepAvailabilityInput): boolean => {
  if (action === 'add') {
    return attributePoints >= step;
  }

  return currentValue >= step;
};

export const getAttributePointActionLabel = (
  action: AttributePointAction,
  attributeLabel: string,
  step: AttributePointStep,
): string => {
  return `${action === 'add' ? '增加' : '减少'}${step}点${attributeLabel}`;
};
