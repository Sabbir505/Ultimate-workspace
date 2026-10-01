// Tests for the MCP registry section (§4.3.3): searching hits the registry
// ipc, results render with the status badge and env keys, and install hands
// the full entry to mcp_registry_install then refreshes the server list.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mcpGalleryList = vi.fn();
const mcpRegistrySearch = vi.fn();
const mcpRegistryInstall = vi.fn();
const toastError = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    mcpGalleryList: (...a: unknown[]) => mcpGalleryList(...a),
    mcpGalleryInstall: vi.fn().mockResolvedValue(null),
    mcpGalleryRemove: vi.fn().mockResolvedValue(null),
    mcpGallerySetEnabled: vi.fn().mockResolvedValue(null),
    mcpGalleryConnect: vi.fn().mockResolvedValue(null),
    mcpGalleryDisconnect: vi.fn().mockResolvedValue(null),
    mcpRegistrySearch: (...a: unknown[]) => mcpRegistrySearch(...a),
    mcpRegistryInstall: (...a: unknown[]) => mcpRegistryInstall(...a),
    toastError: (...a: unknown[]) => toastError(...a),
    toastSuccess: vi.fn(),
  };
});

import { McpGalleryPanel } from "../components/settings/McpGalleryPanel";

const FIXTURE_ENTRY = {
  name: "com.pulsemcp/remote-filesystem",
  title: "Remote Filesystem",
  description: "MCP server for remote filesystem operations on cloud storage.",
  version: "0.1.3",
  repositoryUrl: "https://github.com/pulsemcp/mcp-servers",
  status: "active",
  isLatest: true,
  remoteOnly: false,
  packages: [
    {
      registryType: "npm",
      identifier: "remote-filesystem-mcp-server",
      version: "0.1.3",
      runtimeHint: "npx",
      runtimeArgs: ["-y"],
      envVars: [
        { name: "GCS_BUCKET", description: "Bucket name.", required: true, secret: false },
        { name: "GCS_PRIVATE_KEY", description: "Key.", required: false, secret: true },
      ],
    },
  ],
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mcpGalleryList.mockResolvedValue({ catalog: [], installed: [] });
  toastError.mockReturnValue(undefined);
});

describe("MCP registry section", () => {
  it("auto-searches (debounced) as the user types and renders a grid with badges", async () => {
    mcpRegistrySearch.mockResolvedValue([FIXTURE_ENTRY]);
    render(<McpGalleryPanel />);
    const input = await screen.findByPlaceholderText(/Search the official MCP registry/);
    fireEvent.change(input, { target: { value: "filesystem" } });
    // No Search button anymore — the debounce fires the query.
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    const card = await screen.findByTestId("registry-result", {}, { timeout: 3000 });
    expect(card.className).toContain("mcp-gallery-card");
    expect(mcpRegistrySearch).toHaveBeenCalledTimes(1);
    expect(mcpRegistrySearch).toHaveBeenCalledWith("filesystem", 30);
    expect(screen.getByText("registry ✓")).toBeTruthy();
    expect(screen.getByText(/GCS_BUCKET/)).toBeTruthy();
    expect(screen.getByText("com.pulsemcp/remote-filesystem")).toBeTruthy();
  });

  it("an emptied input clears the results without firing", async () => {
    mcpRegistrySearch.mockResolvedValue([FIXTURE_ENTRY]);
    render(<McpGalleryPanel />);
    const input = await screen.findByPlaceholderText(/Search the official MCP registry/);
    fireEvent.change(input, { target: { value: "fs" } });
    await screen.findByTestId("registry-result", {}, { timeout: 3000 });
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.queryByTestId("registry-result")).toBeNull();
    });
    expect(mcpRegistrySearch).toHaveBeenCalledTimes(1);
  });

  it("install hands the FULL entry to the backend and refreshes", async () => {
    mcpRegistrySearch.mockResolvedValue([FIXTURE_ENTRY]);
    mcpRegistryInstall.mockResolvedValue({ ...FIXTURE_ENTRY, id: "com_pulsemcp_remote_filesystem", command: "npx", args: ["-y", "remote-filesystem-mcp-server@0.1.3"], env: { GCS_BUCKET: "" }, enabled: true, fromGallery: false });
    render(<McpGalleryPanel />);
    const input = await screen.findByPlaceholderText(/Search the official MCP registry/);
    fireEvent.change(input, { target: { value: "filesystem" } });
    const installBtn = await screen.findByRole("button", { name: "Install" }, { timeout: 3000 });
    fireEvent.click(installBtn);
    await waitFor(() => {
      expect(mcpRegistryInstall).toHaveBeenCalledTimes(1);
    });
    // The whole entry round-trips (the backend rebuilds + validates the def).
    expect(mcpRegistryInstall.mock.calls[0][0]).toMatchObject({
      name: "com.pulsemcp/remote-filesystem",
      packages: [{ identifier: "remote-filesystem-mcp-server" }],
    });
    // And the server list refreshed.
    await waitFor(() => {
      expect(mcpGalleryList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("a failed search surfaces the error and an empty state", async () => {
    mcpRegistrySearch.mockRejectedValue("registry returned HTTP 503");
    render(<McpGalleryPanel />);
    const input = await screen.findByPlaceholderText(/Search the official MCP registry/);
    fireEvent.change(input, { target: { value: "x" } });
    await waitFor(
      () => {
        expect(toastError).toHaveBeenCalledWith("Registry search failed", "registry returned HTTP 503");
      },
      { timeout: 3000 }
    );
    expect(await screen.findByText("No registry servers matched.")).toBeTruthy();
  });
});
