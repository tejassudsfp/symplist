import type { ReactNode, Ref } from "react";
import { ThemeIllustration } from "./empty-state.tsx";
import { SkeletonLines } from "./skeleton.tsx";

export function RouteState({
  title,
  description,
  action,
  headingRef,
  alert = false,
  embedded = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly alert?: boolean;
  readonly embedded?: boolean;
}) {
  return (
    <section
      className={`sym-route-state${embedded ? " sym-route-state--embedded" : ""}`}
      aria-labelledby="sym-route-state-title"
      {...(alert ? { role: "alert" as const } : {})}
    >
      <ThemeIllustration />
      <h1 id="sym-route-state-title" ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <p className="sym-route-state-description">{description}</p>
      {action ? <div className="sym-route-state-actions">{action}</div> : null}
    </section>
  );
}

export function RouteLoading({ embedded = false }: { readonly embedded?: boolean }) {
  return (
    <section
      className={`sym-route-state sym-route-state--loading${embedded ? " sym-route-state--embedded" : ""}`}
      aria-labelledby="sym-route-loading-title"
      aria-busy="true"
    >
      <h1 id="sym-route-loading-title">Opening this page</h1>
      <p>The current view will stay in place while its next region is prepared.</p>
      <SkeletonLines label="Loading this page" widths={["45%", "88%", "72%", "56%"]} />
    </section>
  );
}
