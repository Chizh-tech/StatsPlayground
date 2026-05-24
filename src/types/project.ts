/** 项目元数据 */
export interface ProjectInfo {
  name: string;
  filePath: string;
  createdAt: string;
}

/** open_project 返回结果，包含历史/快照数据 + 文件夹布局 */
export interface OpenProjectResult {
  project: ProjectInfo;
  history: unknown[];
  snapshots: unknown[];
  graphBuilders: unknown[];
  /** 项目内所有文件夹路径（含空文件夹），使用 "/" 分隔，根目录不出现在列表中。 */
  folders: string[];
  /** datasetId → folder path（根目录的表不在此映射中）。 */
  tableFolders: Record<string, string>;
  /** graphId → folder path（根目录的图不在此映射中）。 */
  graphFolders: Record<string, string>;
}

/** 导入 .sptb 的返回值。
 *  按 #7 设计，.sptb 文件本身不携带 folder 信息——导入后默认落在根目录，
 *  调用方可选地把它移动到目标文件夹。 */
export interface ImportTableResult {
  id: string;
}
