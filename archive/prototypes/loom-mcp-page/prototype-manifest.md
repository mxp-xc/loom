Topic: MCP dense console page
Prototype root: temp/prototypes/mcp-page/
Preview: bun --cwd temp/prototypes/mcp-page dev
Carrier: sidecar
Touchpoints:

- none outside temp/prototypes/mcp-page
  Verification:
- playwright-cli -s=mcp-proto-ecc2bbf2 goto http://127.0.0.1:5187/
- playwright-cli run-code: captured desktop.png, long-text.png, mobile.png
- checked no console errors; checked no horizontal overflow at 1440px and 375px
- checked empty and error states render expected copy
- after browser comments: removed duplicate detail targets/flow chips; checked inventory/workbench/detail stay 760px before/after long-text selection at 1604x1272
- after browser comments: captured after-comments-desktop.png; checked no console errors and no horizontal overflow at 1604px and 375px
- after second browser comments: stdio detail shows transport/env only; remote detail shows transport/env/headers as separate full-width rows; captured after-comments-2-remote.png
- after third browser comments: added settings.json-style global targets bar; target chip aria/tooltip use claude-code/codex/opencode ids; verified global opencode toggle applies to all 4 rows; Project changes gap is 9px; captured after-comments-3-global-targets.png
- after fourth browser comment: removed visible prototype state switch; verified no normal/long-state control text remains; captured after-comments-4-remove-state-switch.png
- after fifth browser comment: added interpolation preview for variable tokens; verified highlighted token cursor pointer, resolved preview, variable info panel, and 3-step trace; captured after-comments-5-variable-preview.png
- after sixth browser comment: changed variable trace from inline panel to fixed dialog; verified click opens dialog, detail scrollTop stays 0, header geometry is unchanged, close works; captured after-comments-6-variable-dialog.png
- after seventh browser comment: restyled variable dialog to match Vars modal structure (scrim, popover panel, head/body/footer, definition + trace cards); verified desktop dialog, 375px single-column layout, no horizontal overflow, 0 console errors; captured after-comments-7-vars-style-dialog.png and after-comments-7-vars-style-dialog-mobile.png
- after eighth browser comments: changed variable trace semantics to base/base.agent -> local/local.agent -> runtime and removed internal MCP env / vars.* wording; restyled Project changes and dialog close buttons to remove hard white bordered boxes; verified 0 console errors, no horizontal overflow, and captured after-comments-8-trace-buttons.png plus after-comments-8-project-button-top.png
- after ninth browser comments: replaced literal base/local/runtime rows with a compact resolution timeline (Base / Local / Runtime cards with readable titles and notes); synchronized projection path rows to low-contrast filled surfaces with colored left accents instead of hard borders; verified desktop and 375px mobile dialog, no horizontal overflow, 0 console errors; captured after-comments-9-trace-timeline.png, after-comments-9-path-rows.png, and after-comments-9-trace-timeline-mobile.png
- after tenth browser comments: improved inactive projection path readability (OC row no longer sinks into black); made inventory list fill the card and removed horizontal overflow by hiding list-card chip tooltips in the compact inventory context; verified desktop and 375px no horizontal overflow, 0 console errors; captured after-comments-10-scroll-path-contrast.png and after-comments-10-path-row-visible.png
- add/edit editor round 1: added embedded editor sheet opened by Add server and detail edit icon; validated create/edit entry points, rounded action dock, variable inspector from editor env preview, transport switching, desktop/mobile overflow; captured editor-redesign-create-final.png, editor-redesign-edit-final.png, editor-redesign-edit-sse.png, editor-redesign-mobile-editor-final.png
- add/edit editor round 2: removed projection target controls from editor, changed new server default targets to none, moved JSON preview to a full-width bottom card and removed target fields from preview payload; verified no target card/right column, sse headers preview, desktop/mobile no horizontal overflow, 0 console errors; captured editor-redesign-no-target-light.png, editor-redesign-preview-bottom-light.png, editor-redesign-no-target-mobile.png
- add/edit/detail target preview round: moved Add server and Project changes into the inventory header, moved edit/delete actions into server list rows, removed list count text, added reusable per-target settings preview for detail/editor with target-specific variable resolution, moved projection paths to the bottom and removed its left copy; verified CC/CX preview resolves browsers_path differently, list edit opens editor, desktop/mobile no horizontal overflow, 0 console errors; captured detail-target-preview-list-actions.png, editor-list-edit-target-preview.png, detail-bottom-projection-paths.png, detail-target-preview-mobile.png
- final target context round: removed projection paths from detail, promoted CC/CX/OC into a page-level preview context shared by transport/env/headers/settings preview, kept editor projection targets out of the form, and softened Add/Project/Edit/Delete actions into rounded colored icon controls; verified CC/CX/OC resolve different target vars, preview card has no local target tabs, desktop/mobile no horizontal overflow, and 0 console errors; captured final-detail-cx-light.png, final-detail-oc-light.png, final-editor-oc-preview-light.png, final-editor-preview-bottom-light.png, final-mobile-detail-light.png, final-mobile-editor-light.png
- style refresh round: replaced the standalone mint/grid hero style with a compact module-native page head, neutral cards, Skills-like Add server / project buttons, and Vars/Skills-style squircle row actions; verified Add server opens editor, detail target switch remains single/global, preview card has no local target tabs, desktop/mobile no horizontal overflow, and 0 console errors; captured style-refresh-final-desktop.png and style-refresh-final-mobile.png
- spacing/width fix round: added inventory search spacing below the panel header divider and fixed target preview switch/settings preview intrinsic sizing so CC/CX/OC changes only affect preview height, not card width; verified 10px search gap, stable 208px switch width, stable 748px preview card width across targets, desktop/mobile no horizontal overflow, and 0 console errors; captured fix-spacing-width-final.png
  Promotion target:
- packages/web/src/views/Mcp.tsx
- packages/web/src/views/Mcp.module.css
  Cleanup:
- remove temp/prototypes/mcp-page after prototype decision
- temp/prototypes/mcp-page/node_modules is a junction to packages/web/node_modules
