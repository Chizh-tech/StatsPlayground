import { a as __toESM, n as require_react } from "./index-ahixs0Dz.js";
import { ReportView, t as require_jsx_runtime } from "./ReportView-DKy8_J0E.js";
//#region tests/reportViewHarness.tsx
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
var baseItem = {
	schemaVersion: 1,
	id: "report-1",
	name: "Weekly Summary",
	markdown: "",
	createdAt: "2026-09-02T10:00:00.000Z",
	updatedAt: "2026-09-02T10:00:00.000Z"
};
var tableOptions = [{
	id: "table-1",
	name: "Incoming Data"
}];
var graphOptions = [{
	id: "graph-1",
	name: "Scatter Plot"
}];
var fitYByXOptions = [{
	id: "fit-1",
	name: "Strength vs Time"
}];
var tabulateOptions = [{
	id: "tab-1",
	name: "Grouped Summary"
}];
function ReportViewHarness({ initialMarkdown = "" }) {
	const [markdown, setMarkdown] = (0, import_react.useState)(initialMarkdown);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReportView, {
		item: {
			...baseItem,
			markdown,
			updatedAt: "2026-09-02T10:05:00.000Z"
		},
		tableOptions,
		graphOptions,
		fitYByXOptions,
		tabulateOptions,
		onMarkdownChange: setMarkdown
	});
}
//#endregion
export { ReportViewHarness };

//# sourceMappingURL=reportViewHarness-D6opLyCV.js.map