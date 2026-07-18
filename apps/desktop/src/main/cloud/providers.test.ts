import { describe, expect, it, vi } from "vitest";
import { resolveVercelCredentials } from "./providers";

describe("Vercel credential setup", () => {
  it("uses explicit team and project overrides without scope discovery", async () => {
    const discover = vi.fn();
    await expect(resolveVercelCredentials({ token: " token ", teamId: " team_1 ", projectId: " prj_1 " }, discover))
      .resolves.toEqual({ token: "token", teamId: "team_1", projectId: "prj_1" });
    expect(discover).not.toHaveBeenCalled();
  });

  it("discovers a default team and Sandbox project from a token", async () => {
    const discover = vi.fn().mockResolvedValue({ teamId: "team_auto", projectId: "vercel-sandbox-default-project" });
    await expect(resolveVercelCredentials({ token: "vercel_token" }, discover)).resolves.toEqual({
      token: "vercel_token",
      teamId: "team_auto",
      projectId: "vercel-sandbox-default-project",
    });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ token: "vercel_token" }));
  });

  it("reuses an authenticated Vercel CLI session when no token is pasted", async () => {
    const discover = vi.fn().mockResolvedValue({ teamId: "team_cli", projectId: "vercel-sandbox-default-project" });
    await expect(resolveVercelCredentials({}, discover, () => ({ token: "cli_token" }))).resolves.toEqual({
      token: "cli_token",
      teamId: "team_cli",
      projectId: "vercel-sandbox-default-project",
    });
  });

  it("requires a team when a project override is supplied", async () => {
    await expect(resolveVercelCredentials({ token: "vercel_token", projectId: "prj_1" }, vi.fn()))
      .rejects.toThrow("also requires its team ID");
  });
});
