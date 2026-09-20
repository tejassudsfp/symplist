import { EmptyState, PageIllustration } from "@/components/ui/empty-state";
import { type CollectionId, collectionMeta } from "./routes.ts";

/** The page area for a collection with no task selected (sample "No selection"). */
export function CollectionHome({ collection }: { collection: CollectionId }) {
  return (
    <>
      <h1 className="sr-only">{collectionMeta(collection).label}</h1>
      <EmptyState
        align="center"
        illustration={<PageIllustration />}
        title="Pick a task to open its page"
        description="Its page and conversation open together. Or add a new task in the list."
      />
    </>
  );
}
