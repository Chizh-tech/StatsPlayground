/**
 * Graph Core - 统一图形规范类型
 *
 * 设计目标：
 * - 与具体渲染库（当前为 ECharts）解耦的抽象规范
 * - 描述「图形元素 + 编码通道 + 数据来源」三要素
 * - 可被未来其他模块（统计图、回归图、分布图等）复用
 */

/** 数据字段类型（来自数据表列） */
export type FieldType =
  | "continuous"   // 连续数值
  | "nominal"      // 分类离散
  | "ordinal"      // 有序分类
  | "datetime"     // 时间
  | "id";          // 标识

/** 数据字段引用 */
export interface FieldRef {
  /** 列名，必须存在于数据源中 */
  name: string;
  /** 字段类型，用于决定坐标轴/编码方式 */
  type: FieldType;
}

/** 图形元素类型（一张图可叠加多个元素） */
export type ElementKind =
  | "points"       // 散点
  | "line"         // 折线
  | "bar"          // 柱状（含分组均值）
  | "histogram"    // 直方图
  | "boxplot"      // 箱线
  | "smoother";    // 平滑曲线

/** 平滑器配置 */
export interface SmootherOptions {
  /** 平滑窗口比例 0~1 */
  lambda?: number;
}

/** 单个图形元素的配置 */
export interface ChartElement {
  kind: ElementKind;
  /** 元素是否启用 */
  enabled?: boolean;
  /** 元素特有选项 */
  options?: SmootherOptions & Record<string, unknown>;
}

/** 编码通道：将数据字段映射到视觉属性 */
export interface Encoding {
  /** X 轴 */
  x?: FieldRef;
  /** Y 轴 */
  y?: FieldRef;
  /** 颜色编码（分组着色 / 连续色阶） */
  color?: FieldRef;
  /** 尺寸编码 */
  size?: FieldRef;
  /** 叠加（同图叠绘多条系列） */
  overlay?: FieldRef;
  /** 横向分面 */
  groupX?: FieldRef;
  /** 纵向分面 */
  groupY?: FieldRef;
  /** 自动换行分面 */
  wrap?: FieldRef;
}

/** 完整的图形规范 */
export interface GraphSpec {
  /** 数据集标识（仅用于缓存/标题） */
  datasetId?: string;
  /** 数据集名称（标题用） */
  datasetName?: string;
  /** 编码 */
  encoding: Encoding;
  /** 图形元素列表（按层叠绘） */
  elements: ChartElement[];
  /** 标题（可选，未提供则按编码生成） */
  title?: string;
}

/** 原始数据：列式 */
export interface GraphData {
  columns: string[];
  /** 行数据，与 columns 一一对应 */
  rows: unknown[][];
}

/** 字段类型推断：根据列的 SQL 类型字符串 */
export function inferFieldType(sqlType: string): FieldType {
  const t = (sqlType || "").toUpperCase();
  if (
    t.includes("INT") ||
    t.includes("DOUBLE") ||
    t.includes("FLOAT") ||
    t.includes("REAL") ||
    t.includes("DECIMAL") ||
    t.includes("NUMERIC") ||
    t.includes("HUGEINT") ||
    t.includes("BIGINT")
  ) {
    return "continuous";
  }
  if (t.includes("DATE") || t.includes("TIME") || t.includes("TIMESTAMP")) {
    return "datetime";
  }
  if (t.includes("BOOL")) {
    return "nominal";
  }
  return "nominal";
}
