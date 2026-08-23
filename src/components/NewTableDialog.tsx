import { useState } from "react";
import { useTranslation } from "react-i18next";

interface NewTableDialogProps {
  open: boolean;
  readOnly?: boolean;
  onClose: () => void;
  onCreate: (name: string, columns: { name: string; type: string }[]) => void;
}

const COLUMN_TYPES = ["VARCHAR", "INTEGER", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"];

export function NewTableDialog({ open, readOnly = false, onClose, onCreate }: NewTableDialogProps) {
  const { t } = useTranslation();
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState([{ name: "", type: "VARCHAR" }]);

  if (!open) return null;

  const addColumn = () => {
    if (readOnly) return;
    setColumns([...columns, { name: "", type: "VARCHAR" }]);
  };

  const removeColumn = (index: number) => {
    if (readOnly) return;
    if (columns.length <= 1) return;
    setColumns(columns.filter((_, i) => i !== index));
  };

  const updateColumn = (index: number, field: "name" | "type", value: string) => {
    if (readOnly) return;
    const updated = [...columns];
    updated[index] = { ...updated[index], [field]: value };
    setColumns(updated);
  };

  const handleSubmit = () => {
    if (readOnly) return;
    const validName = tableName.trim();
    const validCols = columns.filter((c) => c.name.trim());
    if (!validName || validCols.length === 0) return;
    onCreate(
      validName,
      validCols.map((c) => ({ name: c.name.trim(), type: c.type }))
    );
    // Reset
    setTableName("");
    setColumns([{ name: "", type: "VARCHAR" }]);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("newTable.title")}</h3>
        <div className="dialog-field">
          <label>{t("newTable.tableName")}</label>
          <input
            type="text"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder={t("newTable.tableNamePlaceholder")}
            disabled={readOnly}
            autoFocus
          />
        </div>

        <div className="dialog-field">
          <label>{t("newTable.columns")}</label>
          <div className="column-list">
            {columns.map((col, i) => (
              <div key={i} className="column-row">
                <input
                  type="text"
                  value={col.name}
                  onChange={(e) => updateColumn(i, "name", e.target.value)}
                  placeholder={t("newTable.columnName")}
                  disabled={readOnly}
                />
                <select value={col.type} onChange={(e) => updateColumn(i, "type", e.target.value)} disabled={readOnly}>
                  {COLUMN_TYPES.map((tp) => (
                    <option key={tp} value={tp}>{tp}</option>
                  ))}
                </select>
                <button className="btn-icon" onClick={() => removeColumn(i)} title={t("newTable.removeColumn")} disabled={readOnly}>×</button>
              </div>
            ))}
          </div>
          <button className="btn-text" onClick={addColumn} disabled={readOnly}>{t("newTable.addColumn")}</button>
        </div>

        <div className="dialog-actions">
          <button className="btn-primary" onClick={handleSubmit} disabled={readOnly || !tableName.trim()}>
            {t("common.create")}
          </button>
          <button className="btn-text" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
