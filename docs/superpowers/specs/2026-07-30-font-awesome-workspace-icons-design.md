# Font Awesome Workspace Icons Design

## Scope

Replace six workspace icons with Font Awesome Solid icons:

- Save: `fa-floppy-disk`
- New folder: `fa-folder-plus`
- Collapse all: `fa-down-left-and-up-right-to-center`
- Folder: `fa-folder`
- Table: `fa-table`
- Graph Builder: `fa-chart-pie`

Snapshot, activity bar, history, chevron, and other icons remain unchanged.

## Integration

Install the official `@fortawesome/fontawesome-free` npm package and import its CSS from the frontend entry point so all icon fonts are bundled with the Tauri desktop application and remain available offline.

Replace the six inline SVG elements in `Workspace.tsx` with semantic `<i>` elements using the requested `fa-solid` classes. Preserve existing button labels, tooltips, event handlers, and accessibility behavior.

## Styling

Do not apply the sample inline RGB color. The new icons inherit `currentColor` from the existing menu, panel action, folder row, dataset row, active, hover, dirty, light-theme, and dark-theme styles. Preserve the current visual dimensions through the existing icon class or minimal size-only styling where needed.

## Validation

Run the frontend Vite build. Confirm TypeScript compilation and Font Awesome asset bundling complete without errors.