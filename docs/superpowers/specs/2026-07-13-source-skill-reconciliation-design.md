# Source skill reconciliation

## Goal

When a remote skill source changes, Loom updates the cached content, reconciles the source member list, reports updated, added, and removed skills, and projects the resulting desired state automatically. A removed remote skill can be preserved as a repository-local skill without losing its previous targets.

The same removal confirmation applies when editing a source or its `scan` pattern produces a member set that omits previously selected members.

Related rules: [cross-cutting](../../rules/cross-cutting.md), [projection](../../rules/projection.md), and [skills](../../rules/skills.md).

## Reconciliation model

The server compares the previous saved source members with the newly scanned members:

- Added: present only in the new member set.
- Removed: present only in the previous member set.
- Updated: present in both sets, but the skill content or source-relative path changed.
- Unchanged: present in both sets with identical content and path.

Reconciliation is used by both remote source updates and source member saves after changing `scan`. The operation does not report success until the manifest is saved and skills projection succeeds.

## Two-phase remote update

Remote updates use a server-managed prepare/finalize session.

Prepare fetches the selected ref and updates the remote cache. Before replacing old content, it stages complete copies of members that may be removed. It scans the new cache, computes the change summary, and returns a persisted session identifier plus the added, updated, and removed lists.

If no members were removed, the client immediately finalizes. If members were removed, the client opens the reconciliation dialog and sends the selected members to finalize. Finalize persists the new `pinned_commit`, replaces the source member set with the scan result while preserving existing member settings for matching names, converts selected removed members to local skills, and runs skills projection.

Session metadata and staged content survive a server restart and remain until finalize succeeds; Loom must not discard the only recoverable copy before the user decides. Session failures are logged with the complete error object. Loom does not report the update as completed while a session still needs a removal decision.

## Preserving removed skills

Selected removed members are copied with their complete directory contents to `assets/skills/<skill-id>` and registered as pathless local skills. Their previous source-member targets are retained.

Loom never overwrites an existing local skill directory or an existing local manifest entry with the same id. A collision blocks finalize and returns an explicit error so the user can resolve it without losing either copy.

Unselected removed members are removed from desired state. Projection cleanup remains subject to the existing managed-artifact rules.

## Editing source members and scan

Saving a source edit first compares the current saved members with the newly selected scan view. If previously saved members are missing, Loom opens the same reconciliation dialog before changing the manifest.

Because the remote cache has not been replaced in this flow, selected removed members can be copied directly from their current cached paths. After the choice is submitted, Loom saves source metadata and members, preserves selected removals as local skills, and projects skills as one application-level operation.

## User interface

The completion dialog displays separate Added, Updated, and Removed sections. Added and updated items are informational. Removed items are selectable and default to selected, where selected means preserve as local.

The removed section provides:

- Select all.
- Clear selection.
- Do not preserve, which clears the selection and proceeds with deletion after an explicit confirmation action.
- A primary action that preserves the selected items and deletes the unselected items.

The dialog cannot imply completion before finalize succeeds. On failure it remains actionable and shows the returned error. After success the manifest reloads and the UI shows the final added, updated, preserved, and deleted summary.

## API boundaries

The server owns comparison, staging, persistence, local conversion, and projection. The web client owns only presenting the change set and submitting the preservation choices.

Remote update prepare and source-edit reconciliation return structured member changes. Finalize requests identify the session or source operation and contain only the names selected for preservation. The server validates that choices are a subset of the reported removed members.

## Error handling and safety

- Cache update, manifest write, local copy, and projection errors are surfaced and logged with complete error objects.
- Existing local content is never overwritten.
- Invalid sessions fail explicitly; persisted prepared sessions remain recoverable across server restarts.
- Preserve choices cannot name members outside the prepared removal set.
- A partial manifest mutation triggers a manifest refresh so the UI reflects persisted state.
- Temporary staged content stays under the repository `temp/` area and is removed after finalize or expiry.

## Verification

Server tests cover change classification, content staging before cache replacement, target retention, collision rejection, session validation and cleanup, manifest persistence, and automatic projection.

Web tests cover the three change lists, default select-all state, select all, clear selection, do-not-preserve behavior, partial preservation, failure state, and both remote-update and edited-scan entry points. Browser verification covers the completed dialog flow at desktop and mobile widths.

The skills rules document gains the reconciliation and preservation contract, with links to the new server and web tests.
