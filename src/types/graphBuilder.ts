/**
 * 图表构建器项 — 与数据表平行的项目级实体。
 *
 * 引用一个数据表作为数据源，自身仅保存编码与元素配置。
 */

import type { ChartElement, FieldRef, GroupStyleMap } from "@/graphCore";
import type { GraphFilterRuleItem } from "./graphFilter";

export type GraphSlotKey =
  | "x"
  | "y"
  | "color"
  | "size"
  | "overlay"
  | "groupX"
  | "groupY"
  | "wrap";

export interface GraphBuilderItem {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 引用的数据表 ID */
  sourceDatasetId: string;
  /** 编码槽：字段引用 */
  encoding: Partial<Record<GraphSlotKey, FieldRef>>;
  /** 启用的图形元素 */
  elements: ChartElement[];
  /** 平滑器 lambda 0~1 */
  smootherLambda: number;
  /** Per-group line/fill/point style overrides. Keys are the category
   *  values from the Color/Overlay encoding (or DEFAULT_GROUP_KEY). */
  groupStyles?: GroupStyleMap;
  /** Legend entries the user has explicitly hidden via the eye-icon
   *  toggle. Hidden groups are excluded from the rendered series and
   *  from the shared-axis range calculation, but keep their slot in
   *  globalGroupKeys so unhiding restores the same color. */
  hiddenGroups?: string[];
  /** JMP-style Local Data Filter rules. Each rule narrows (AND) or
   *  expands (OR) the row set fed into the graph. Stored on the item so
   *  it persists with the project and survives reloads. */
  filters?: GraphFilterRuleItem[];
  /** 创建时间 ISO 字符串。
 *
 *  注：图所属的文件夹不属于图本身的内禀属性——按 #7 设计，文件夹只
 *  是图在 spprj 内被放置到的位置。该映射由 `useFolderStore.graphFolders`
 *  统一管理，保存时单独传给后端，绝不持久化在 .spgh 文件体里。 */
  createdAt: string;
}
