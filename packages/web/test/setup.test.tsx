import { afterEach, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Setup from "../src/pages/admin/Setup";
vi.mock("../src/stores", () => ({
  useAuthStore: (fn: (s: unknown) => unknown) =>
    fn({ user: { role: "super_admin" } }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const initial = {
  connected: false,
  method: null,
  domain: "example.com",
  oauthAvailable: false,
  progress: [],
  plan: null,
};
it("defaults to API token and does not offer an unconfigured OAuth action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, data: initial })),
  );
  render(<Setup />);
  await screen.findByText(
    "OAuth is not enabled for this installation. Paste an API token above.",
  );
  expect(
    screen.getByRole("button", { name: "Connect with API token" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Start OAuth connection" }),
  ).toBeNull();
});
it("clears the pasted token after saving and never sends it to an external URL", async () => {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json({
        success: true,
        data: url.endsWith("/zones") ? [] : initial,
      });
    }),
  );
  render(<Setup />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: "sensitive-token" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Connect with API token" }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe(
      "",
    ),
  );
  expect(
    calls.every((c) => (c as [string])[0].startsWith("/api/admin/setup")),
  ).toBe(true);
});
it("requires review and refuses a blocked plan", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json({
        success: true,
        data: url.includes("/zones")
          ? [{ id: "z", name: "example.com" }]
          : url.includes("/workers")
            ? [{ id: "worker" }]
            : {
                ...initial,
                connected: true,
                plan: {
                  id: "p",
                  expires: Date.now() + 1000,
                  plan: {
                    target: {
                      zoneId: "z",
                      workerName: "worker",
                      webHostname: "",
                    },
                    changes: ["Enable mail"],
                    blockers: ["Existing mail provider"],
                  },
                },
              },
      }),
    ),
  );
  render(<Setup />);
  await screen.findByText("Existing mail provider");
  expect(
    (
      screen.getByRole("button", {
        name: "Apply reviewed changes",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("accepts browser handoff only from the fragment and clears it before finishing", async () => {
  const code = "c".repeat(43);
  window.history.replaceState(null, "", "/admin/setup#oauth_code=" + code);
  const mock = vi.fn(async () =>
    Response.json({
      success: true,
      data: { ...initial, oauthAvailable: true },
    }),
  );
  vi.stubGlobal("fetch", mock);
  render(<Setup />);
  await screen.findByRole("button", { name: "Finish connection" });
  expect(window.location.hash).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Finish connection" }));
  await waitFor(() =>
    expect(mock).toHaveBeenCalledWith(
      "/api/admin/setup/oauth/finish",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code }),
        credentials: "include",
      }),
    ),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Finish connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
});
