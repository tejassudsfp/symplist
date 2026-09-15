"use client";

import { EmptyState } from "@/components/ui/empty-state";

export interface DocumentPaneProps {
  /** The selected task. The shell mounts a fresh pane for each task. */
  readonly taskId: string;
}

/**
 * The selected task's page, shown in the shell's page frame (§2.3). PLACEHOLDER: the documents
 * feature replaces this body with the editor (§9.3); until then it shows the sample's empty page.
 */
export function DocumentPane(_props: DocumentPaneProps) {
  return (
    <>
      <h1 className="sr-only">Task page</h1>
      <EmptyState
        title="Nothing on this page yet"
        description="Start writing, or ask Simon to draft a first section."
      />
    </>
  );
}
