/**
 * REST request and response schemas for task labels (§2.1).
 *
 * A label is the owner's own word for a slice of their list. The name is theirs — encrypted at rest as
 * `tasks.title_enc` is — and the colour is not: it is one of the eight accent preset names the
 * appearance settings already use, so a label list can be ordered and rendered without decrypting
 * anything, and so the palette stays the one the themes were designed around.
 */

import { idSchema, taskIdSchema } from "../common/ids.ts";
import { counterSchema, epochMillisSchema } from "../common/primitives.ts";
import { z } from "../common/zod.ts";
import { appearanceAccentPresets } from "./accents.ts";

/**
 * A label's colour: an accent preset name, never a custom hex.
 *
 * Appearance settings allow a custom `#RRGGBB` accent; labels deliberately do not. A label is read at
 * a glance against six themes in light and dark, and a free-form colour is the one thing a person can
 * choose that renders illegibly in half of them. The preset names resolve per theme, so the same label
 * stays readable everywhere.
 */
export const labelColourSchema = z.enum(appearanceAccentPresets);
export type LabelColour = z.infer<typeof labelColourSchema>;

/** How long a label's name may be. Short on purpose: it has to fit a chip beside a task title. */
export const LABEL_NAME_MAX_LENGTH = 32;

/**
 * How many labels one owner may have.
 *
 * A cap exists because the filter bar renders every label and the service compares decrypted names to
 * enforce uniqueness, so both are bounded by this rather than by the size of the list.
 */
export const LABEL_MAX_PER_OWNER = 60;

/** How many labels one task may carry, so a task row never becomes a wall of chips. */
export const LABEL_MAX_PER_TASK = 8;

/**
 * A label name as stored: trimmed, inner whitespace collapsed, and non-empty.
 *
 * Normalised rather than taken literally, because " work " and "work" are the same label to the person
 * typing them, and the uniqueness check compares these strings.
 *
 * {@link normalizeLabelName} is exported separately because the service applies it as well: uniqueness
 * is decided by comparing these strings, so nothing that reaches the service should be able to store
 * " work " beside "work", whether or not it came through this schema.
 */
export function normalizeLabelName(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export const labelNameSchema = z
  .string()
  .transform(normalizeLabelName)
  .refine((value) => value.length > 0, { error: "Enter a name for the label" })
  .refine((value) => value.length <= LABEL_NAME_MAX_LENGTH, {
    error: `At most ${LABEL_NAME_MAX_LENGTH} characters`,
  })
  // A control character would render as nothing and make two labels look identical.
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), { error: "That name can't be used" });

export const labelViewSchema = z.strictObject({
  id: idSchema,
  name: z.string().max(LABEL_NAME_MAX_LENGTH),
  colour: labelColourSchema,
  /** How many active tasks carry it, so the filter bar can show a count and hide empty labels. */
  taskCount: counterSchema,
  createdAt: epochMillisSchema,
  updatedAt: epochMillisSchema,
});
export type LabelView = z.infer<typeof labelViewSchema>;

export const labelListSchema = z.strictObject({
  labels: z.array(labelViewSchema),
});
export type LabelList = z.infer<typeof labelListSchema>;

export const labelCreateSchema = z.strictObject({
  name: labelNameSchema,
  colour: labelColourSchema,
});
export type LabelCreate = z.infer<typeof labelCreateSchema>;

/** A rename, a recolour, or both. An empty patch is refused rather than treated as a no-op write. */
export const labelUpdateSchema = z
  .strictObject({
    name: labelNameSchema.optional(),
    colour: labelColourSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.colour !== undefined, {
    error: "Change a name or a colour",
  });
export type LabelUpdate = z.infer<typeof labelUpdateSchema>;

export const labelParamsSchema = z.strictObject({ id: idSchema });
export type LabelParams = z.infer<typeof labelParamsSchema>;

/**
 * The labels a task carries, set as a whole rather than added and removed one at a time.
 *
 * Replacing the set is what makes this idempotent and what makes a concurrent edit from two surfaces
 * — the task row and a connected agent — resolve to a state the person can see, rather than to a
 * difference of two deltas neither of them sent.
 */
export const taskLabelsUpdateSchema = z.strictObject({
  labelIds: z.array(idSchema).max(LABEL_MAX_PER_TASK),
});
export type TaskLabelsUpdate = z.infer<typeof taskLabelsUpdateSchema>;

export const taskLabelsSchema = z.strictObject({
  taskId: taskIdSchema,
  labelIds: z.array(idSchema),
});
export type TaskLabels = z.infer<typeof taskLabelsSchema>;
