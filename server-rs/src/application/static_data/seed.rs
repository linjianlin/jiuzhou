use std::fs;
use std::path::PathBuf;

use serde::de::DeserializeOwned;

use crate::shared::error::AppError;

/**
 * 静态种子读取工具。
 *
 * 作用：
 * 1. 做什么：集中提供 Rust 静态配置层共用的种子文件定位、JSON 反序列化与按前缀列文件能力。
 * 2. 做什么：把 `server/` 权威种子目录的路径规则收敛到单一入口，避免多个静态索引模块各自拼路径、各自处理排序。
 * 3. 不做什么：不解释业务语义，不做字段映射，也不吞掉文件缺失/JSON 结构错误。
 *
 * 输入 / 输出：
 * - 输入：种子文件名或前缀。
 * - 输出：类型化 JSON 结果、绝对路径，或按名称排序后的文件名列表。
 *
 * 数据流 / 状态流：
 * - 静态索引模块 -> 本模块定位 `server/src/data/seeds` -> 读取 JSON / 枚举文件 -> 上层做业务索引构建。
 *
 * 复用设计说明：
 * - `catalog` 与后续扩展的静态索引都依赖同一个 Node 种子目录；统一封装后，路径变更和文件枚举规则只维护一处。
 * - 文件排序集中在这里，避免多个模块对同一批 `dungeon_*.json` 产生不同遍历顺序。
 *
 * 关键边界条件与坑点：
 * 1. 读取失败必须直接向上抛错，不能返回空结构冒充“没有配置”。
 * 2. 文件枚举返回的是文件名而不是完整路径，调用方若混入非种子目录路径，会破坏统一目录约束；因此这里只支持权威 seeds 目录。
 */
pub fn read_seed_json<T>(file_name: &str) -> Result<T, AppError>
where
    T: DeserializeOwned,
{
    let file_path = seed_file_path(file_name);
    let content = fs::read_to_string(file_path).map_err(AppError::Io)?;
    serde_json::from_str(&content).map_err(AppError::SerdeJson)
}

pub fn list_seed_files_with_prefix(prefix: &str) -> Result<Vec<String>, AppError> {
    let mut file_names = fs::read_dir(seed_root_path())
        .map_err(AppError::Io)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|file_name| file_name.starts_with(prefix) && file_name.ends_with(".json"))
        .collect::<Vec<_>>();
    file_names.sort();
    Ok(file_names)
}

pub fn seed_file_path(file_name: &str) -> PathBuf {
    seed_root_path().join(file_name)
}

fn seed_root_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds")
}
