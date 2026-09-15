# Vault — create/edit secret or note

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design Add item with a simple type choice: Secret or Secure note. Fields: title and the value/body. Secret value is masked by default with deliberate reveal; secure note supports a modest Markdown editor. Save and Cancel remain clear. Do not add categories, folders, expiration schedules, or sharing defaults unless marked as future proposals.

Use fictional sample content only. Show Secret and Secure note variants, create versus edit, dirty state, saving, saved, failed save with draft preserved, missing title, and concurrent edit conflict. Avoid echoing secret values in validation errors.

If the vault locks while the editor is open, design a safe re-unlock transition. Do not display plaintext beneath a lock overlay. Annotate the tension between preserving an unsaved draft and clearing unlocked data; choose an explicit encrypted-draft or discard-with-warning proposal rather than promising impossible recovery.

Delete is a separate destructive confirmation with the item title and clear scope. Editing a value should not silently change a pending agent approval; indicate when the user must review the new value's grant. Sharing the item with a task is handled in agent_approval.md, not an automatic effect of saving.

Mobile keyboard and long note editing need enough room. Show reveal button states and accessible labels that identify whether the value is currently hidden. Theme details must not obscure text selection or secret masking.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
