import type { YAxisConfig } from "@/graphCore";

export function prepareAxisBinding(
  previousFieldName: string | undefined,
  nextFieldName: string | undefined,
  hadMulti: boolean,
  axisConfig: YAxisConfig | undefined,
): { bindingChanged: boolean; axisConfig: YAxisConfig | undefined } {
  const bindingChanged = hadMulti || previousFieldName !== nextFieldName;
  if (!bindingChanged) {
    return { bindingChanged, axisConfig };
  }
  if (!axisConfig) {
    return { bindingChanged, axisConfig: undefined };
  }

  const { min: _min, max: _max, tickInterval: _tickInterval, ...displayFields } = axisConfig;
  return {
    bindingChanged,
    axisConfig: Object.keys(displayFields).length > 0 ? displayFields : undefined,
  };
}