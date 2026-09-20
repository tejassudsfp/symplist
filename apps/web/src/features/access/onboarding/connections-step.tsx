"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../api.ts";
import { problemOf } from "../errors.ts";
import { IdentityMenu } from "../gate/identity-menu.tsx";
import { useDestinationGuard } from "../gate/use-destination-guard.ts";
import { APP_HOME_PATH, ONBOARDING_NAME_PATH } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { Notice } from "../ui/notice.tsx";
import { OnboardingProgress } from "./onboarding-steps.tsx";

export interface OnboardingConnectionsProps {
  /**
   * The connector tiles, supplied by the connections feature (§14). Without them this deployment has
   * no connectors to offer yet and the step says so plainly instead of showing broken tiles.
   */
  readonly catalogue?: ReactNode;
}

/**
 * Onboarding, step two (onboarding_connections.md): an optional invitation to connect services.
 * Continue and Skip for now are equally clear, and neither is required to enter the app — every
 * native task and document tool works without a connector.
 */
export function OnboardingConnections({ catalogue }: OnboardingConnectionsProps) {
  const api = useAccessApi();
  const controls = useSessionControls();
  const router = useRouter();
  const { me, allowed } = useDestinationGuard(["onboarding"]);
  const [finishing, setFinishing] = useState<"continue" | "skip" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!me || !allowed) {
    return (
      <EntryFrame width="wide">
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening Symplist…
        </p>
      </EntryFrame>
    );
  }

  const finish = async (mode: "continue" | "skip") => {
    if (finishing) return;
    setFinishing(mode);
    setFailure(null);
    try {
      const next = await api.completeOnboarding();
      controls.setMe(next);
      router.replace(APP_HOME_PATH);
    } catch (error) {
      const problem = problemOf(error);
      if (problem.kind === "api" && problem.code === "onboarding.name_required") {
        router.replace(ONBOARDING_NAME_PATH);
        return;
      }
      setFailure(
        problem.kind === "network"
          ? "Symplist couldn't be reached. Check your connection and try again."
          : problem.kind === "session_expired"
            ? "Your session has ended. Sign in again to continue."
            : "Something went wrong on our side. Try again.",
      );
    } finally {
      setFinishing(null);
    }
  };

  return (
    <EntryFrame width="wide" headerEnd={<IdentityMenu me={me} />}>
      <OnboardingProgress current="connections" />
      <div className="flex flex-col gap-2">
        <ScreenHeading>Connect what you use</ScreenHeading>
        <Lede>You can do this later. Nothing in Symplist needs a connected service.</Lede>
      </div>
      <div data-slot="connections-catalogue">
        {catalogue ?? (
          <Notice tone="info" live="none" title="No connectors are set up here yet">
            When this deployment offers connectors, they appear here and in Settings → Connections.
            Until then, tasks, pages and Simon work on their own.
          </Notice>
        )}
      </div>
      <p className="m-0 text-[12.5px] text-sym-muted [text-wrap:pretty]">
        A connection decides what Simon may reach on your behalf. Actions that send or change
        something outside Symplist still ask you to approve them first, and you can disconnect a
        service at any time in Settings → Connections.
      </p>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="lg"
          disabled={finishing !== null}
          aria-busy={finishing === "continue" || undefined}
          onClick={() => {
            void finish("continue");
          }}
        >
          {finishing === "continue" ? <Spinner size={12} /> : null}
          {finishing === "continue" ? "Opening Symplist…" : "Continue"}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          disabled={finishing !== null}
          aria-busy={finishing === "skip" || undefined}
          onClick={() => {
            void finish("skip");
          }}
        >
          {finishing === "skip" ? <Spinner size={12} /> : null}
          {finishing === "skip" ? "Opening Symplist…" : "Skip for now"}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          disabled={finishing !== null}
          onClick={() => router.push(ONBOARDING_NAME_PATH)}
        >
          Back
        </Button>
      </div>
    </EntryFrame>
  );
}
