import { accessLevels } from "@symplist/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  type Session,
  SessionGate,
  SessionProvider,
  useSession,
  useSessionControls,
} from "./session.tsx";
import { SessionStore } from "./session-store.ts";
import { resetSignOutForTests } from "./sign-out.ts";
import {
  admittedAccess,
  lockedAccess,
  mayaMe,
  pausedAccess,
  renderAccess,
  signedOutError,
  stubNavigation,
} from "./test-support.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/now", replace: vi.fn(), push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

let location = stubNavigation("/now");

beforeEach(() => {
  navigation.pathname = "/now";
  navigation.replace.mockReset();
  navigation.push.mockReset();
  window.sessionStorage.clear();
  resetSignOutForTests();
  location = stubNavigation("/now");
});

afterEach(() => {
  location.restore();
});

function SessionProbe() {
  const session = useSession();
  return <p>{`${session.status} ${session.user?.displayName ?? "nobody"}`}</p>;
}

const maya: Session = {
  status: "signed_in",
  user: {
    id: mayaMe().user.id,
    displayName: "Maya Rao",
    email: "maya@example.com",
    role: "member",
  },
  access: admittedAccess,
};

describe("the session seam", () => {
  it("reports a session that is still loading until the identity answers", async () => {
    const store = new SessionStore({ me: () => new Promise(() => undefined) });
    render(
      <SessionProvider store={store}>
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

  it("resolves the signed-in person from the identity route", async () => {
    renderAccess(<SessionProbe />, { me: mayaMe() });
    expect(await screen.findByText("signed_in Maya Rao")).toBeInTheDocument();
  });

  it("falls back to the email address until onboarding saves a name", async () => {
    renderAccess(<SessionProbe />, {
      me: mayaMe({ access: lockedAccess, user: { displayName: null } as never }),
    });
    expect(await screen.findByText("signed_in maya@example.com")).toBeInTheDocument();
  });

  it("refuses to read the session outside its provider", () => {
    expect(() => render(<SessionProbe />)).toThrow(
      "useSession must be used inside SessionProvider",
    );
  });

  it.each(accessLevels)(
    "renders gated content for an admitted admin at the %s level",
    async (level) => {
      renderAccess(
        <SessionGate require={level}>
          <h1>Gated content</h1>
        </SessionGate>,
        { me: mayaMe({ user: { role: "admin" } as never }) },
      );
      expect(await screen.findByRole("heading", { name: "Gated content" })).toBeInTheDocument();
    },
  );
});

describe("SessionGate", () => {
  it("shows a loading status instead of protected content while the identity is unknown", () => {
    const store = new SessionStore({ me: () => new Promise(() => undefined) });
    render(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading Symplist…");
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("sends a signed-out visitor to the email entry with a return path", async () => {
    navigation.pathname = "/settings/account";
    location.setPath("/settings/account");
    const store = new SessionStore({
      me: async () => {
        throw signedOutError();
      },
    });
    render(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(location.replace).toHaveBeenCalledWith("/signin?next=%2Fsettings%2Faccount"),
    );
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("explains an expired session instead of redirecting silently", async () => {
    let answer: "ok" | "gone" = "ok";
    const store = new SessionStore({
      me: async () => {
        if (answer === "gone") throw signedOutError();
        return mayaMe();
      },
    });
    const { rerender } = render(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "Workspace" });
    answer = "gone";
    await store.refresh();
    rerender(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Your session has ended" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("offers a retry when the identity could not be read at all", async () => {
    const user = userEvent.setup();
    let fail = true;
    const store = new SessionStore({
      me: async () => {
        if (fail) throw new ApiNetworkError();
        return mayaMe();
      },
    });
    render(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Couldn't open Symplist" }),
    ).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeInTheDocument();
  });

  it("sends a locked account to the beta gate and renders nothing protected", async () => {
    renderAccess(
      <SessionGate require="admitted">
        <h1>Workspace</h1>
      </SessionGate>,
      { me: mayaMe({ access: lockedAccess }) },
    );
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith("/access"));
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("sends an account that has not finished onboarding to the welcome step", async () => {
    renderAccess(
      <SessionGate require="admitted">
        <h1>Workspace</h1>
      </SessionGate>,
      { me: mayaMe({ access: { ...admittedAccess, onboardingStep: "connections" } }) },
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/welcome/connections"));
  });

  it("keeps a locked account inside an identity-level group", async () => {
    renderAccess(
      <SessionGate require="identity">
        <h1>Beta gate</h1>
      </SessionGate>,
      { me: mayaMe({ access: lockedAccess }) },
    );
    expect(await screen.findByRole("heading", { name: "Beta gate" })).toBeInTheDocument();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("replaces open content and records the interruption when access is taken away", async () => {
    const store = new SessionStore({ me: async () => mayaMe() });
    const { rerender } = render(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "Workspace" });
    store.setMe(mayaMe({ access: pausedAccess }));
    rerender(
      <SessionProvider store={store}>
        <SessionGate require="admitted">
          <h1>Workspace</h1>
        </SessionGate>
      </SessionProvider>,
    );
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith("/access/paused"));
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("symplist.access.interrupted")).toBe("1");
  });

  it("refuses administration to an admitted account without the role", async () => {
    renderAccess(
      <SessionGate require="admin">
        <h1>Beta administration</h1>
      </SessionGate>,
      { me: mayaMe() },
    );
    expect(
      await screen.findByRole("heading", { name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Beta administration" })).not.toBeInTheDocument();
  });
});

describe("session controls", () => {
  it("applies an identity the api just returned without another request", async () => {
    function Probe() {
      const controls = useSessionControls();
      return (
        <button type="button" onClick={() => controls.setMe(mayaMe({ access: lockedAccess }))}>
          {controls.me?.destination ?? "unknown"}
        </button>
      );
    }
    const user = userEvent.setup();
    renderAccess(<Probe />, { me: mayaMe() });
    const button = await screen.findByRole("button", { name: "app" });
    await user.click(button);
    expect(await screen.findByRole("button", { name: "beta_gate" })).toBeInTheDocument();
  });
});
