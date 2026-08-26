# Distribution synthetic seed corpus

该目录只存放自有合成输入的固定种子与摘要，不包含第三方产品输出、截图、文本或原始验证资料。

- `seedId`、`caseId`：稳定机器 ID。
- `seed`：确定性整数种子。
- `inputHash`、`expectedHash`：`sha256:` 摘要。
- `status`：固定为 `synthetic`。

Golden runner 仅比较摘要；相同 seed 和 case ID 必须在所有平台生成相同结果。