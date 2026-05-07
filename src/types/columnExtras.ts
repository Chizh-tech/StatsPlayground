/**
 * 列的"附加属性"注册表。
 *
 * 这里集中定义了所有支持的附加属性 kind、它们的字段、默认值与显示标签。
 * 增加一种新 kind 时只需要：
 *   1) 在 ExtraKind 中加入新键
 *   2) 在 EXTRA_DEFS 中加入对应定义
 * 列属性对话框、批量管理表（PR2）、序列化路径都会自动获得支持。
 */

export type ExtraKind = "unit" | "spec" | "range" | "notes";

export type ExtraFieldType = "text" | "number" | "longtext";

export interface ExtraFieldDef {
  /** 字段键（用于在 value 对象内取值，例如 spec.lsl） */
  key: string;
  /** UI 显示标签 */
  label: string;
  /** 输入控件类型 */
  type: ExtraFieldType;
}

export interface ExtraDef {
  kind: ExtraKind;
  /** 在下拉菜单与卡片标题中显示的中文名 */
  label: string;
  /** 简短说明，用作 placeholder/tooltip */
  description?: string;
  fields: ExtraFieldDef[];
  /** 新建时填充的默认值 */
  defaultValue: () => Record<string, unknown>;
}

export const EXTRA_DEFS: Record<ExtraKind, ExtraDef> = {
  unit: {
    kind: "unit",
    label: "单位",
    description: "列数值的物理/业务单位，例如 mm、kg、°C",
    fields: [{ key: "value", label: "单位", type: "text" }],
    defaultValue: () => ({ value: "" }),
  },
  spec: {
    kind: "spec",
    label: "规格",
    description: "规格上下限与目标值，用于过程能力分析等",
    fields: [
      { key: "lsl", label: "下限", type: "number" },
      { key: "target", label: "目标", type: "number" },
      { key: "usl", label: "上限", type: "number" },
    ],
    defaultValue: () => ({ lsl: null, target: null, usl: null }),
  },
  range: {
    kind: "range",
    label: "范围检查",
    description: "合法取值的最小/最大值，超出范围标记异常",
    fields: [
      { key: "min", label: "最小", type: "number" },
      { key: "max", label: "最大", type: "number" },
    ],
    defaultValue: () => ({ min: null, max: null }),
  },
  notes: {
    kind: "notes",
    label: "备注",
    description: "对该列的自由文本说明",
    fields: [{ key: "value", label: "备注", type: "longtext" }],
    defaultValue: () => ({ value: "" }),
  },
};

/** 全部 kind，按对话框下拉中希望出现的顺序 */
export const EXTRA_KINDS: ExtraKind[] = ["unit", "spec", "range", "notes"];

export function getExtraDef(kind: string): ExtraDef | undefined {
  return (EXTRA_DEFS as Record<string, ExtraDef | undefined>)[kind];
}

/** 用于左侧列面板小徽标的提示文本，例如"单位、规格" */
export function summarizeExtraKinds(extras: Record<string, unknown> | undefined): string {
  if (!extras) return "";
  const labels: string[] = [];
  for (const k of EXTRA_KINDS) {
    if (extras[k] !== undefined) labels.push(EXTRA_DEFS[k].label);
  }
  // 兼容未来未注册的 kind（占位显示原始 key）
  for (const k of Object.keys(extras)) {
    if (!(k in EXTRA_DEFS)) labels.push(k);
  }
  return labels.join("、");
}
