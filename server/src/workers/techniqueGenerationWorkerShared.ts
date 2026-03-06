/**
 * 洞府研修 worker 通讯协议
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中定义主线程与研修 worker 之间的消息类型，避免 runner 与 worker 各自维护一份字符串协议。
 * 2) 不做什么：不负责业务执行、不负责状态落库、不负责 WebSocket 推送。
 *
 * 输入/输出：
 * - 输入：主线程投递的执行消息。
 * - 输出：worker 返回的 ready / result / error 消息。
 *
 * 数据流/状态流：
 * runner -> techniqueGenerationWorkerMessage -> worker
 * worker -> techniqueGenerationWorkerResponse -> runner
 *
 * 关键边界条件与坑点：
 * 1) `quality` 与 `status` 都必须复用后端业务类型，避免字符串拼写漂移。
 * 2) 该协议只覆盖当前研修任务，不混入其他 worker 任务，防止不同业务共享消息体导致耦合。
 */
import type {
  TechniquePreview,
  TechniqueQuality,
  TechniqueResearchResultStatus,
} from '../services/techniqueGenerationService.js';

export type TechniqueGenerationWorkerPayload = {
  characterId: number;
  generationId: string;
  quality: TechniqueQuality;
};

export type TechniqueGenerationWorkerMessage =
  | { type: 'executeTechniqueGeneration'; payload: TechniqueGenerationWorkerPayload }
  | { type: 'shutdown' };

export type TechniqueGenerationWorkerResult = {
  generationId: string;
  characterId: number;
  status: TechniqueResearchResultStatus;
  preview: TechniquePreview | null;
  errorMessage: string | null;
};

export type TechniqueGenerationWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; payload: TechniqueGenerationWorkerResult }
  | { type: 'error'; payload: { generationId: string; characterId: number; error: string; stack?: string } };
