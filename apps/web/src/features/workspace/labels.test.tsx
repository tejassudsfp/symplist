import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LabelsSettings } from "./labels-settings.tsx";
import { TaskInbox } from "./task-inbox.tsx";
import { FakeWorkspaceApi, renderWorkspace } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/now",
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: (href: string) => {
      navigation.push(href);
      navigation.pathname = href;
    },
    replace: (href: string) => {
      navigation.replace(href);
      navigation.pathname = href;
    },
    prefetch: () => undefined,
    back: () => undefined,
  }),
}));

beforeEach(() => {
  navigation.pathname = "/now";
  navigation.push.mockClear();
  navigation.replace.mockClear();
});

function seeded(): FakeWorkspaceApi {
  const api = new FakeWorkspaceApi();
  api.seedLabel("work", "Work", "blue");
  api.seedLabel("errands", "Errands", "amber");
  api.seed({ id: "outline", title: "Send the project outline", labelIds: ["work"] });
  api.seed({ id: "bike", title: "Book a bike tune-up", labelIds: ["errands"] });
  api.seed({ id: "weekend", title: "Plan a quiet weekend" });
  return api;
}

async function inbox(api = seeded()) {
  const result = renderWorkspace(<TaskInbox collection="now" />, { api });
  await screen.findByText("Send the project outline");
  return result;
}

function row(title: string): HTMLElement {
  const node = screen.getByText(title).closest<HTMLElement>(".sym-task-row");
  if (!node) throw new Error(`no row for ${title}`);
  return node;
}

function filterChip(name: string): HTMLElement {
  return within(document.querySelector<HTMLElement>(".sym-label-filter") as HTMLElement).getByRole(
    "button",
    { name: new RegExp(`^${name}`) },
  );
}

describe("labels in the list", () => {
  it("shows a task's labels on its row", async () => {
    await inbox();
    expect(within(row("Send the project outline")).getByText("Work")).toBeInTheDocument();
    expect(within(row("Book a bike tune-up")).getByText("Errands")).toBeInTheDocument();
    expect(within(row("Plan a quiet weekend")).queryByText("Work")).not.toBeInTheDocument();
  });

  it("filters the list to one label, and narrows further with a second", async () => {
    const api = seeded();
    // A task with both labels, so a second chip has something to narrow to.
    api.seed({ id: "both", title: "Return the library books", labelIds: ["work", "errands"] });
    const { user } = await inbox(api);

    await user.click(filterChip("Work"));
    await waitFor(() => {
      expect(screen.queryByText("Plan a quiet weekend")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Send the project outline")).toBeInTheDocument();
    expect(screen.getByText("Return the library books")).toBeInTheDocument();

    // A second label narrows rather than widens: only the task carrying both stays.
    await user.click(filterChip("Errands"));
    await waitFor(() => {
      expect(screen.queryByText("Send the project outline")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Return the library books")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await screen.findByText("Plan a quiet weekend");
  });

  it("says which labels are narrowing a list that has nothing to show", async () => {
    const { user } = await inbox();
    await user.click(filterChip("Work"));
    await user.click(filterChip("Errands"));
    expect(
      await screen.findByText("No tasks in Now are labelled “Work” and “Errands”."),
    ).toBeInTheDocument();
  });

  it("shows each label's count and keeps it in step with a change", async () => {
    const { api, user } = await inbox();
    expect(filterChip("Work")).toHaveTextContent("1");
    // The row's menu is the way a label goes on or off a task.
    await user.click(
      within(row("Plan a quiet weekend")).getByRole("button", {
        name: "Task menu for Plan a quiet weekend",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Labels…/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    await waitFor(() => {
      expect(api.labelsOf("weekend")).toEqual(["work"]);
    });
    await waitFor(() => {
      expect(filterChip("Work")).toHaveTextContent("2");
    });
    expect(within(row("Plan a quiet weekend")).getByText("Work")).toBeInTheDocument();
  });

  it("takes a label off again, and reverts the chip when the write fails", async () => {
    const { api, user } = await inbox();
    await user.click(
      within(row("Send the project outline")).getByRole("button", {
        name: "Task menu for Send the project outline",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Labels…/ }));
    api.fail("setTaskLabels");
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    // The chip comes back, because the list only keeps what the server accepted.
    await waitFor(() => {
      expect(within(row("Send the project outline")).getByText("Work")).toBeInTheDocument();
    });
    expect(api.labelsOf("outline")).toEqual(["work"]);
    expect(await screen.findByText(/Couldn't remove “Work”/)).toBeInTheDocument();
  });

  it("shows no filter bar at all for an account with no labels", async () => {
    const api = new FakeWorkspaceApi();
    api.seed({ id: "outline", title: "Send the project outline" });
    renderWorkspace(<TaskInbox collection="now" />, { api });
    await screen.findByText("Send the project outline");
    expect(document.querySelector(".sym-label-filter")).toBeNull();
  });
});

describe("labels in settings", () => {
  async function settings(api = seeded()) {
    const result = renderWorkspace(<LabelsSettings />, { api });
    await screen.findByText("Work");
    return result;
  }

  it("lists the account's labels with how many tasks carry each", async () => {
    await settings();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Work"),
      expect.stringContaining("Errands"),
    ]);
    expect(rows[0]?.textContent).toContain("1 task");
  });

  it("adds a label with a name and a colour", async () => {
    const { api, user } = await settings();
    await user.type(screen.getByLabelText("Name"), "  Reading  ");
    await user.click(screen.getByRole("radio", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: /Add label/ }));
    await screen.findByText("Reading");
    const created = (await api.listLabels()).labels.find((label) => label.name === "Reading");
    // Normalised on the way in, so the chip and the uniqueness check agree.
    expect(created).toMatchObject({ name: "Reading", colour: "teal" });
  });

  it("names the clash when the name is already in use, and keeps what was typed", async () => {
    const { user } = await settings();
    await user.type(screen.getByLabelText("Name"), "work");
    await user.click(screen.getByRole("button", { name: /Add label/ }));
    expect(await screen.findByText("You already have a label with that name.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("work");
  });

  it("renames a label", async () => {
    const { api, user } = await settings();
    await user.click(screen.getByRole("button", { name: "Edit Work" }));
    const field = screen.getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Studio");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await screen.findByText("Studio");
    expect((await api.listLabels()).labels.map((label) => label.name)).toEqual([
      "Studio",
      "Errands",
    ]);
  });

  it("deletes a label and offers to bring it back", async () => {
    const { api, user } = await settings();
    await user.click(screen.getByRole("button", { name: "Delete Work" }));
    await waitFor(() => {
      expect(screen.queryByText("Work")).not.toBeInTheDocument();
    });
    // Undo re-creates the label; the toast says the chips did not come with it.
    expect(
      await screen.findByText(/Deleted “Work”\. Tasks that had it keep everything else\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Work");
    expect(api.labelsOf("outline")).toEqual([]);
  });
});
