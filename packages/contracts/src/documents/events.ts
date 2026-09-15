import { z } from "zod";
import { taskIdSchema } from "../common/ids.ts";
import { defineEvents } from "../common/ws.ts";
import { documentAuthorSchema, documentRevisionSchema, documentSectionIdSchema } from "./dto.ts";

/** `document.head_changed` (§7): a new revision was published for a task; ids only, never text. */
export const documentHeadChangedEventSchema = z.strictObject({
  taskId: taskIdSchema,
  revision: documentRevisionSchema,
  author: documentAuthorSchema,
  /** Sections of the new revision that were added or modified (at most 100). */
  changedSectionIds: z.array(documentSectionIdSchema).max(100),
});
export type DocumentHeadChangedEvent = z.infer<typeof documentHeadChangedEventSchema>;

/** WebSocket events owned by the documents feature (§9, §7), keyed by event type. */
export const documentsEvents = defineEvents({
  "document.head_changed": documentHeadChangedEventSchema,
});
