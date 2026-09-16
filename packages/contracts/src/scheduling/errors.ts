import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the scheduling feature (§12, §6), mapped to HTTP statuses. */
export const schedulingErrorCodes = defineErrorCodes({
  "schedule.conflict": 409,
  "schedule.invalid_time": 422,
  "schedule.dst_choice": 422,
  "schedule.past_reminder": 422,
  "schedule.deadline_required": 422,
  "schedule.channel_disabled": 422,
  "schedule.unavailable": 503,
});
