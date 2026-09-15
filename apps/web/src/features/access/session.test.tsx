import { accessLevels, accessStateSchema, userIdSchema } from "@symplist/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Session, SessionGate, SessionProvider, useSession } from "./session.tsx";

const maya: Session = {
  status: "signed_in",
  user: {
    id: userIdSchema.parse("01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a"),
    displayName: "Maya Rao",
    email: "maya@example.com",
    role: "member",
  },
  access: accessStateSchema.parse({
    emailVerifiedAt: Date.UTC(2026, 8, 1),
    betaState: "unlocked",
    suspendedAt: null,
    onboardingStep: "done",
    role: "member",
    accessGeneration: 1,
    accessEpoch: 0,
    deletionState: "none",
  }),
};

function SessionProbe() {
  const session = useSession();
  return <p>{`${session.status} ${session.user?.displayName ?? "nobody"}`}</p>;
}

describe("session seam placeholder", () => {
  it("reports a session that is still loading until the access feature resolves one", () => {
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );
    expect(screen.getByText("loading nobody")).toBeInTheDocument();
  });

  it("uses a fixed session when one is provided", () => {
    render(
      <SessionProvider value={maya}>
        <SessionProbe />
      </SessionProvider>,
    );
    expect(screen.getByText("signed_in Maya Rao")).toBeInTheDocument();
  });

  it("refuses to read the session outside its provider", () => {
    expect(() => render(<SessionProbe />)).toThrow(
      "useSession must be used inside SessionProvider",
    );
  });

  it.each(accessLevels)("renders the gated content at the %s level", (level) => {
    render(
      <SessionProvider>
        <SessionGate require={level}>
          <h1>Gated content</h1>
        </SessionGate>
      </SessionProvider>,
    );
    expect(screen.getByRole("heading", { name: "Gated content" })).toBeInTheDocument();
  });
});
