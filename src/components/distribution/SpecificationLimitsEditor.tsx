import { useTranslation } from "react-i18next";

import type { CapabilityOverrideEnvelopeV1 } from "@/types/distribution";

import { NORMAL_CAPABILITY_ID } from "./distributionConfig";

interface SpecificationLimitsEditorProps {
  override: CapabilityOverrideEnvelopeV1 | null;
  yCount: number;
  onChange: (override: CapabilityOverrideEnvelopeV1 | null) => void;
}

const emptyOverride = (): CapabilityOverrideEnvelopeV1 => ({
  schemaVersion: "1",
  capabilityId: NORMAL_CAPABILITY_ID,
  payloadSchemaVersion: "1",
  payload: { lsl: null, target: null, usl: null },
});

export function SpecificationLimitsEditor({
  override,
  yCount,
  onChange,
}: SpecificationLimitsEditorProps) {
  const { t } = useTranslation();
  const setLimit = (key: "lsl" | "target" | "usl", raw: string) => {
    if (!override) return;
    onChange({
      ...override,
      payload: {
        ...override.payload,
        [key]: raw.trim() === "" ? null : Number(raw),
      },
    });
  };

  return (
    <section className="distribution-spec-editor">
      <label className="distribution-option distribution-option-checkbox">
        <input
          type="checkbox"
          checked={override !== null}
          onChange={(event) => onChange(event.target.checked ? emptyOverride() : null)}
        />
        <span>{t("distribution.specification.useOverride")}</span>
      </label>
      {override && (
        <>
          {yCount > 1 && <p>{t("distribution.specification.allYHint")}</p>}
          <div className="distribution-spec-fields">
            {(["lsl", "target", "usl"] as const).map((key) => (
              <label key={key}>
                <span>{t(`distribution.specification.${key}`)}</span>
                <input
                  type="number"
                  value={typeof override.payload[key] === "number" ? override.payload[key] : ""}
                  onChange={(event) => setLimit(key, event.target.value)}
                />
              </label>
            ))}
          </div>
          <p className="distribution-spec-source">{t("distribution.specification.overrideSource")}</p>
        </>
      )}
    </section>
  );
}