/**
 * 应用版本共享规则。
 *
 * 作用：
 * 1. 统一定义前端版本元数据的结构、归一化规则与版本变化判定，避免构建层、运行时服务层和 UI 层各自维护一套字符串判断。
 * 2. 把 `version.json` 路径格式化、版本字段清洗和展示文案收敛到纯函数层，确保测试可以直接覆盖，不依赖浏览器或网络请求。
 * 3. 不做什么：不发请求、不读浏览器环境、不创建定时器，也不直接弹出任何提示 UI。
 *
 * 输入 / 输出：
 * - 输入：原始版本元数据对象、清单路径字符串。
 * - 输出：归一化后的 `AppVersionMeta`、标准化清单路径和稳定展示文案。
 *
 * 数据流 / 状态流：
 * 构建插件生成版本字段
 * -> 运行时服务读取 `version.json`
 * -> 本模块统一归一化与比较
 * -> 根部更新检测组件决定是否提示刷新
 * -> 页头复用同一份展示文案。
 *
 * 复用设计说明：
 * 1. 版本归一化与比较规则属于高频变化点，集中在纯函数模块后，构建层和运行时层只消费结果，不再重复写 trim/比对逻辑。
 * 2. `Game` 页头展示与根部更新提示复用同一份版本元数据，避免再次出现“展示一个版本、检测另一套版本”的漂移。
 * 3. 后续若登录页、设置页也要展示当前构建版本，只需复用本模块输出，不需要复制格式化代码。
 *
 * 关键边界条件与坑点：
 * 1. `version` 与 `builtAt` 都必须是非空字符串，否则不能参与更新比较，避免把损坏清单当成新版本。
 * 2. 清单路径必须统一成以 `/` 开头的绝对相对路径，避免 CDN 基址拼接时出现双斜杠或丢失根路径。
 */

export interface AppVersionMeta {
  version: string;
  builtAt: string;
}

export interface AppVersionMetaSource {
  version?: string | null;
  builtAt?: string | null;
}

const normalizeNonEmptyText = (value?: string | null): string => String(value ?? '').trim();

export const resolveAppVersionManifestPath = (path: string): string => {
  const normalizedPath = normalizeNonEmptyText(path);
  if (!normalizedPath) {
    throw new Error('应用版本清单路径不能为空');
  }
  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
};

export const normalizeAppVersionMeta = (source: AppVersionMetaSource): AppVersionMeta => {
  const version = normalizeNonEmptyText(source.version);
  const builtAt = normalizeNonEmptyText(source.builtAt);

  if (!version) {
    throw new Error('应用版本号不能为空');
  }
  if (!builtAt) {
    throw new Error('应用构建时间不能为空');
  }

  return {
    version,
    builtAt,
  };
};

export const hasAppVersionChanged = (
  currentVersion: AppVersionMeta,
  latestVersion: AppVersionMeta,
): boolean => currentVersion.version !== latestVersion.version;

export const formatAppVersionDisplayLabel = (meta: AppVersionMeta): string => meta.version;
