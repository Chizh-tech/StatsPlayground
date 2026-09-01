import { useTranslation } from "react-i18next";

import type { DistributionColumnRefV1 } from "@/types/distribution";

interface DistributionRoleZoneProps {
  role: "Y" | "Weight" | "Frequency" | "By";
  columns: DistributionColumnRefV1[];
  displayNameById?: ReadonlyMap<string, string>;
  onAssign: (columnId: string) => void;
  onRemove: (columnId: string) => void;
}

export function DistributionRoleZone({ role, columns, displayNameById, onAssign, onRemove }: DistributionRoleZoneProps) {
  const { t } = useTranslation();
  const roleLabel = t(`distribution.roles.${role.toLocaleLowerCase()}`);
  return (
    <section
      className="distribution-role-zone"
      data-testid={`distribution-role-${role.toLocaleLowerCase()}`}
      aria-label={t("distribution.roleLabel", { role: roleLabel })}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const columnId = event.dataTransfer.getData("application/x-statsplayground-distribution") ||
          event.dataTransfer.getData("text/plain");
        if (columnId) onAssign(columnId);
      }}
    >
      <h4>{roleLabel}</h4>
      <div className="distribution-role-items">
        {columns.length === 0 ? (
          <span className="distribution-role-empty">{t("distribution.roleEmpty")}</span>
        ) : columns.map((column) => (
          <span className="distribution-role-chip" key={column.columnId}>
            <span className="distribution-role-chip-label" title={displayNameById?.get(column.columnId) ?? column.columnId}>
              {displayNameById?.get(column.columnId) ?? column.columnId}
            </span>
            <button
              type="button"
              className="btn-icon"
              data-testid={`distribution-remove-${role.toLocaleLowerCase()}-${column.columnId}`}
              aria-label={t("distribution.removeFromRole", { column: column.columnId, role: roleLabel })}
              onClick={() => onRemove(column.columnId)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}