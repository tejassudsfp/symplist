import { ApiError } from "@/lib/api";

export function sharingFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "sharing.stale")
      return "The source or access settings changed. Close this review, refresh the page and review again.";
    if (error.code === "sharing.expiry_invalid") return "Choose a future expiry within seven days.";
    if (error.code === "not_found") return "This artifact is no longer available to this account.";
    if (error.code === "task.archived")
      return "Restore this task before creating new snapshots or links.";
    if (error.code === "rate.limited") return "Please wait a moment before trying again.";
  }
  return "That could not be saved. Check your connection and try again.";
}
export function expiryLabel(at: number | null): string {
  return at === null
    ? "Until revoked"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZoneName: undefined,
      }).format(at);
}
export async function copySharingText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export function downloadSharingText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
