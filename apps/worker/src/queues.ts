import { queue } from "@trigger.dev/sdk";

/**
 * The D1 queue family (§3.1). Every task that uses D1 passes one of these objects as its `queue`;
 * no task declares a queue inline, so the number of D1-using worker processes stays bounded.
 */
export const d1 = queue({ name: "d1", concurrencyLimit: 4 });

/** `document-git` only, so `simon-run` never holds the slot its awaited child needs. */
export const d1Git = queue({ name: "d1-git", concurrencyLimit: 2 });

/** `reminder-scan` only, so scans never overlap. */
export const reminderScan = queue({ name: "reminder-scan", concurrencyLimit: 1 });

/** Every queue in the D1 family. */
export const d1QueueFamily = [d1, d1Git, reminderScan] as const;
