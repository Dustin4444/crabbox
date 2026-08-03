import { describe, expect, it, vi } from "vitest";

import { leaseConfig } from "../src/config";
import { DaytonaClient, daytonaAccessNeedsRefresh, daytonaSSHEndpoint } from "../src/daytona";
import type { Env } from "../src/types";

const baseEnv: Env = {
  FLEET: {} as DurableObjectNamespace,
  HETZNER_TOKEN: "",
  DAYTONA_CRABBOX_KEY: "daytona-test-key",
  CRABBOX_DAYTONA_API_URL: "https://daytona.example/api",
  CRABBOX_DAYTONA_SNAPSHOT: "crabbox-ready",
};
const baseImage = `daytonaio/sandbox@sha256:${"a".repeat(64)}`;

describe("daytona coordinator client", () => {
  it("requires a dedicated Worker secret and a safe API URL", () => {
    expect(() => new DaytonaClient({ ...baseEnv, DAYTONA_CRABBOX_KEY: "" })).toThrow(
      "DAYTONA_CRABBOX_KEY secret is required",
    );
    expect(
      () =>
        new DaytonaClient({
          ...baseEnv,
          CRABBOX_DAYTONA_API_URL: "https://user:secret@daytona.example/api",
        }),
    ).toThrow("must not contain credentials");
    expect(
      () =>
        new DaytonaClient({
          ...baseEnv,
          CRABBOX_DAYTONA_API_URL: "http://daytona.example/api",
        }),
    ).toThrow("must use https");
  });

  it("creates owned sandboxes, paginates inventory, and mints SSH access", async () => {
    const requests: Request[] = [];
    const authorizationHeaders: Array<string | null> = [];
    const createBodies: Record<string, unknown>[] = [];
    const listLabels: Array<string | null> = [];
    const accessMinutes: Array<string | null> = [];
    const client = new DaytonaClient(baseEnv);
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      authorizationHeaders.push(request.headers.get("authorization"));
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        const body = (await request.json()) as Record<string, unknown>;
        createBodies.push(body);
        return Response.json({
          id: "sandbox-one",
          name: "crabbox-blue-lobster",
          snapshot: "crabbox-ready",
          state: "creating",
          labels: body["labels"],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/sandbox") {
        const cursor = url.searchParams.get("cursor");
        listLabels.push(url.searchParams.get("labels"));
        return Response.json(
          cursor
            ? {
                items: [
                  {
                    id: "sandbox-two",
                    name: "crabbox-two",
                    state: "started",
                    labels: { crabbox: "true" },
                  },
                ],
                nextCursor: null,
              }
            : {
                items: [
                  {
                    id: "sandbox-one",
                    name: "crabbox-one",
                    state: "started",
                    labels: { crabbox: "true" },
                  },
                ],
                nextCursor: "next",
              },
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/ssh-access")) {
        accessMinutes.push(url.searchParams.get("expiresInMinutes"));
        return Response.json({
          token: "ssh-secret",
          expiresAt: "2026-07-06T12:00:00Z",
          sshCommand: "ssh -p 2222 ssh-secret@ssh.daytona.example",
        });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    const config = leaseConfig({
      provider: "daytona",
      sshPublicKey: "ssh-ed25519 test",
      idleTimeoutSeconds: 600,
    });
    const created = await client.createServer(
      config,
      "cbx_abcdef123456",
      "blue-lobster",
      "alice@example.com",
    );
    expect(created).toMatchObject({
      provider: "daytona",
      cloudID: "sandbox-one",
      status: "creating",
      serverType: "crabbox-ready",
    });
    await expect(client.listCrabboxServers()).resolves.toHaveLength(2);
    await expect(client.createSSHAccess("sandbox-one")).resolves.toEqual({
      user: "ssh-secret",
      host: "ssh.daytona.example",
      port: "2222",
      expiresAt: "2026-07-06T12:00:00Z",
    });
    expect(requests).toHaveLength(4);
    expect(authorizationHeaders).toEqual(Array(4).fill("Bearer daytona-test-key"));
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toMatchObject({
      snapshot: "crabbox-ready",
      autoStopInterval: 0,
      autoDeleteInterval: -1,
      labels: {
        crabbox: "true",
        created_by: "crabbox",
        lease: "cbx_abcdef123456",
        owner: "alice_example.com",
        provider: "daytona",
        slug: "blue-lobster",
      },
    });
    expect(listLabels).toEqual(['{"crabbox":"true"}', '{"crabbox":"true"}']);
    expect(accessMinutes).toEqual(["120"]);
  });

  it("redacts credentials from provider error diagnostics", async () => {
    const client = new DaytonaClient(baseEnv);
    client.fetcher = async () =>
      new Response(
        'route=iad https://passwordless-url-token@provider.example/path {"access_token":"access-value","refresh_token":"refresh-value","refreshToken":"refresh-camel-value","id_token":"id-value","idToken":"id-camel-value","secretAccessKey":"aws-camel-value","secret_access_key":"aws-snake-value","apiSecret":"api-value","workerKey":"daytona-test-key"}',
        { status: 401 },
      );

    const error = await client.listCrabboxServers().catch((caught: unknown) => caught);
    const diagnostic = String(error);
    for (const secret of [
      "passwordless-url-token",
      "access-value",
      "refresh-value",
      "refresh-camel-value",
      "id-value",
      "id-camel-value",
      "aws-camel-value",
      "aws-snake-value",
      "api-value",
      "daytona-test-key",
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(diagnostic).toContain("[redacted]");
    expect(diagnostic).toContain("provider.example/path");
    expect(diagnostic).toContain("route=iad");
  });

  it("treats an already deleted sandbox as successful cleanup", async () => {
    const client = new DaytonaClient(baseEnv);
    client.fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    await expect(client.deleteServer("sandbox-one")).resolves.toBeUndefined();
    await expect(client.deleteServer("sandbox-one")).resolves.toBeUndefined();
    await expect(client.deleteServer("sandbox-one")).rejects.toThrow("http 503");
  });

  it("creates a larger snapshot from the configured base and deletes its builder", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let state = "creating";
    let cleanupPolls = 0;
    let snapshotPolls = 0;
    let snapshotTransitionPolls = 0;
    let cpu = 1;
    let memory = 1;
    let disk = 3;
    const client = new DaytonaClient(baseEnv);
    client.pollDelayMs = 0;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.body ? await request.clone().json() : undefined;
      calls.push({ method: request.method, path: url.pathname, ...(body ? { body } : {}) });
      if (request.method === "GET" && url.pathname === "/api/snapshots/crabbox-ready-2x4x10") {
        if (calls.length === 1) return new Response(null, { status: 404 });
        snapshotPolls += 1;
        if (snapshotPolls === 1) {
          return new Response("temporary provider failure", { status: 503 });
        }
        return Response.json({
          id: "snapshot-one",
          name: "crabbox-ready-2x4x10",
          state: "active",
          cpu,
          mem: memory,
          disk,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        state = "started";
        ({ cpu, memory, disk } = body as { cpu: number; memory: number; disk: number });
        return Response.json({
          id: "snapshot-builder",
          name: "crabbox-snapshot-bootstrap-test",
          state: "creating",
          cpu,
          memory,
          disk,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/sandbox/snapshot-builder") {
        if (state === "snapshotting") {
          snapshotTransitionPolls += 1;
          if (snapshotTransitionPolls === 1) {
            return Response.json({
              id: "snapshot-builder",
              name: "crabbox-snapshot-bootstrap-test",
              state,
              cpu,
              memory,
              disk,
            });
          }
          state = "stopped";
        }
        if (state === "destroying") {
          cleanupPolls += 1;
          if (cleanupPolls === 1) {
            return new Response("temporary provider failure", { status: 503 });
          }
          return Response.json({
            id: "snapshot-builder",
            name: "crabbox-snapshot-bootstrap-test",
            state: cleanupPolls === 2 ? "build_failed" : "destroyed",
          });
        }
        return Response.json({
          id: "snapshot-builder",
          name: "crabbox-snapshot-bootstrap-test",
          state,
          cpu,
          memory,
          disk,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        state = "stopped";
        return Response.json({ id: "snapshot-builder", state });
      }
      if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
        state = "snapshotting";
        return Response.json({ id: "snapshot-builder", state: "snapshotting", disk });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/snapshot-builder")) {
        state = "destroying";
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).resolves.toEqual({
      sourceSnapshot: baseImage,
      sourceCPU: 2,
      sourceMemoryGiB: 4,
      sourceDiskGiB: 10,
      snapshot: "crabbox-ready-2x4x10",
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 10,
      sandboxID: "snapshot-builder",
      cleanup: "deleted",
    });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/snapshots/crabbox-ready-2x4x10",
      "POST /api/sandbox",
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "POST /api/sandbox/snapshot-builder/stop",
      "GET /api/sandbox/snapshot-builder",
      "POST /api/sandbox/snapshot-builder/snapshot",
      "GET /api/snapshots/crabbox-ready-2x4x10",
      "GET /api/snapshots/crabbox-ready-2x4x10",
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "DELETE /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
    ]);
    expect(calls[1]?.body).toMatchObject({
      buildInfo: {
        dockerfileContent: `FROM ${baseImage}`,
      },
      autoStopInterval: 30,
      autoDeleteInterval: 60,
      cpu: 2,
      memory: 4,
      disk: 10,
      labels: {
        created_by: "crabbox",
        purpose: "snapshot-bootstrap",
        snapshot_name: "crabbox-ready-2x4x10",
      },
    });
    expect(calls[1]?.body).not.toMatchObject({
      labels: { crabbox: "true" },
    });
    expect(calls[6]?.body).toEqual({ name: "crabbox-ready-2x4x10" });
  });

  it("deletes the builder when Daytona snapshot bootstrap fails", async () => {
    const methods: string[] = [];
    let deleted = false;
    const client = new DaytonaClient(baseEnv);
    client.pollDelayMs = 0;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      methods.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
        return new Response(null, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        return Response.json({ id: "snapshot-builder", state: "creating" });
      }
      if (request.method === "GET") {
        if (deleted) return new Response(null, { status: 404 });
        return Response.json({
          id: "snapshot-builder",
          state: "started",
          cpu: 2,
          memory: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        return new Response("provider unavailable", { status: 503 });
      }
      if (request.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).rejects.toThrow("http 503");
    expect(methods.slice(-2)).toEqual([
      "DELETE /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
    ]);
  });

  it("rejects a failed snapshot and still waits for builder cleanup", async () => {
    const methods: string[] = [];
    let preflight = true;
    let state = "started";
    let snapshotRequested = false;
    let transitionReadFailed = false;
    const client = new DaytonaClient(baseEnv);
    client.pollDelayMs = 0;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      methods.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
        if (preflight) {
          preflight = false;
          return new Response(null, { status: 404 });
        }
        return Response.json({
          id: "snapshot-one",
          name: "crabbox-ready-2x4x10",
          state: "build_failed",
          errorReason: "registry push failed",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        return Response.json({ id: "snapshot-builder", state: "creating" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/snapshot-builder")) {
        if (state === "destroying") return new Response(null, { status: 404 });
        if (snapshotRequested && !transitionReadFailed) {
          transitionReadFailed = true;
          return new Response("temporary provider failure", { status: 503 });
        }
        return Response.json({
          id: "snapshot-builder",
          state,
          cpu: 2,
          memory: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        state = "stopped";
        return Response.json({ id: "snapshot-builder", state });
      }
      if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
        snapshotRequested = true;
        return Response.json({ id: "snapshot-builder", state: "snapshotting" });
      }
      if (request.method === "DELETE") {
        state = "destroying";
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).rejects.toThrow(
      "daytona snapshot crabbox-ready-2x4x10 entered terminal state=build_failed: registry push failed",
    );
    expect(transitionReadFailed).toBe(true);
    expect(methods.slice(-2)).toEqual([
      "DELETE /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
    ]);
  });

  it("waits out snapshotting when the accepted snapshot response is lost", async () => {
    const methods: string[] = [];
    let state = "started";
    let transitionPolls = 0;
    let snapshotAttempted = false;
    let deleteAttempts = 0;
    let deleted = false;
    const client = new DaytonaClient(baseEnv);
    client.maxWaitMs = 25;
    client.snapshotWaitMs = 100;
    client.pollDelayMs = 10;
    client.snapshotAcceptanceWaitMs = 20;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      methods.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
        return new Response(null, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        return Response.json({ id: "snapshot-builder", state: "creating" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/snapshot-builder")) {
        if (deleted) return new Response(null, { status: 404 });
        if (snapshotAttempted) {
          transitionPolls += 1;
          state =
            transitionPolls === 1 ? "stopped" : transitionPolls <= 3 ? "snapshotting" : "stopped";
        }
        return Response.json({
          id: "snapshot-builder",
          state,
          cpu: 2,
          memory: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        state = "stopped";
        return Response.json({ id: "snapshot-builder", state });
      }
      if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
        snapshotAttempted = true;
        throw new TypeError("network reset after snapshot acceptance");
      }
      if (request.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return new Response("Sandbox state change in progress", { status: 409 });
        }
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).rejects.toThrow("network reset after snapshot acceptance");
    expect(methods.slice(-6)).toEqual([
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
      "DELETE /api/sandbox/snapshot-builder",
      "DELETE /api/sandbox/snapshot-builder",
      "GET /api/sandbox/snapshot-builder",
    ]);
  });

  it("fails cleanup when Daytona accepts delete but never destroys the builder", async () => {
    let preflight = true;
    let state = "started";
    const client = new DaytonaClient(baseEnv);
    client.pollDelayMs = 25;
    client.maxWaitMs = 20;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
        if (preflight) {
          preflight = false;
          return new Response(null, { status: 404 });
        }
        return Response.json({
          id: "snapshot-one",
          name: "crabbox-ready-2x4x10",
          state: "active",
          cpu: 2,
          mem: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        return Response.json({ id: "snapshot-builder", state: "creating" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/snapshot-builder")) {
        return Response.json({
          id: "snapshot-builder",
          state,
          cpu: 2,
          memory: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        state = "stopped";
        return Response.json({ id: "snapshot-builder", state });
      }
      if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
        return Response.json({ id: "snapshot-builder", state: "snapshotting" });
      }
      if (request.method === "DELETE") {
        state = "destroying";
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).rejects.toThrow(
      "timed out waiting for daytona sandbox snapshot-builder cleanup (state=destroying)",
    );
  });

  it("rejects an existing snapshot name before creating a paid builder", async () => {
    const client = new DaytonaClient(baseEnv);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "snapshot-existing",
        name: "crabbox-ready-2x4x10",
        state: "active",
      }),
    );
    client.fetcher = fetchMock;

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).rejects.toThrow("daytona snapshot crabbox-ready-2x4x10 already exists (state=active)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a dedicated bounded snapshot wait longer than sandbox lifecycle waits", async () => {
    let snapshotPolls = 0;
    let state = "started";
    let deleted = false;
    const client = new DaytonaClient(baseEnv);
    client.maxWaitMs = 50;
    client.snapshotWaitMs = 200;
    client.pollDelayMs = 60;
    client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
        snapshotPolls += 1;
        if (snapshotPolls < 3) return new Response(null, { status: 404 });
        return Response.json({
          id: "snapshot-one",
          name: "crabbox-ready-2x4x10",
          state: "active",
          cpu: 2,
          mem: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox") {
        return Response.json({ id: "snapshot-builder", state: "creating" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/snapshot-builder")) {
        if (deleted) return new Response(null, { status: 404 });
        return Response.json({
          id: "snapshot-builder",
          state,
          cpu: 2,
          memory: 4,
          disk: 10,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) {
        state = "stopped";
        return Response.json({ id: "snapshot-builder", state });
      }
      if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
        return Response.json({ id: "snapshot-builder", state: "snapshotting" });
      }
      if (request.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(
      client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
    ).resolves.toMatchObject({
      snapshot: "crabbox-ready-2x4x10",
      cleanup: "deleted",
    });
    expect(client.snapshotWaitMs).toBeGreaterThan(client.maxWaitMs);
    expect(client.snapshotWaitMs).toBeLessThan(30 * 60_000);
    expect(snapshotPolls).toBe(3);
  });

  it.each([2, 6])(
    "deletes the builder when Daytona applies %d GiB instead of the requested memory",
    async (appliedMemoryGiB) => {
      const methods: string[] = [];
      let deleted = false;
      const client = new DaytonaClient(baseEnv);
      client.pollDelayMs = 0;
      client.fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        methods.push(`${request.method} ${url.pathname}`);
        if (request.method === "GET" && url.pathname.startsWith("/api/snapshots/")) {
          return new Response(null, { status: 404 });
        }
        if (request.method === "POST" && url.pathname === "/api/sandbox") {
          return Response.json({ id: "undersized-builder", state: "creating" });
        }
        if (request.method === "GET") {
          if (deleted) return new Response(null, { status: 404 });
          return Response.json({
            id: "undersized-builder",
            state: "started",
            cpu: 2,
            memory: appliedMemoryGiB,
            disk: 10,
          });
        }
        if (request.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      });

      await expect(
        client.bootstrapSnapshot("crabbox-ready-2x4x10", 2, 4, 10, baseImage),
      ).rejects.toThrow(`has ${appliedMemoryGiB} GiB memory after 4 GiB image build`);
      expect(methods.slice(-2)).toEqual([
        "DELETE /api/sandbox/undersized-builder",
        "GET /api/sandbox/undersized-builder",
      ]);
    },
  );

  it.each(["started", "running", "ready", "active", " Active "])(
    "accepts Daytona ready state %j",
    async (state) => {
      const client = new DaytonaClient(baseEnv);
      client.fetcher = async () =>
        Response.json({
          id: "sandbox-one",
          name: "crabbox-one",
          state,
          labels: { crabbox: "true" },
        });

      await expect(client.waitForStarted("sandbox-one")).resolves.toMatchObject({
        cloudID: "sandbox-one",
        status: state,
      });
    },
  );

  it.each(["error", "errored", "failed", "build_failed", "destroyed", "destroying", "deleted"])(
    "rejects Daytona terminal state %j",
    async (state) => {
      const client = new DaytonaClient(baseEnv);
      client.fetcher = async () =>
        Response.json({
          id: "sandbox-one",
          name: "crabbox-one",
          state,
          labels: { crabbox: "true" },
        });

      await expect(client.waitForStarted("sandbox-one")).rejects.toThrow(
        `entered terminal state=${state}`,
      );
    },
  );

  it("parses SSH commands and refreshes expiring access", () => {
    expect(
      daytonaSSHEndpoint({
        token: "fallback-token",
        expiresAt: "2026-07-06T12:00:00Z",
        sshCommand: "ssh -o StrictHostKeyChecking=no -p 2200 live-token@ssh.example",
      }),
    ).toEqual({
      user: "live-token",
      host: "ssh.example",
      port: "2200",
      expiresAt: "2026-07-06T12:00:00Z",
    });
    expect(
      daytonaAccessNeedsRefresh(
        { providerAccessExpiresAt: "2026-07-06T12:05:00Z" },
        Date.parse("2026-07-06T12:00:00Z"),
      ),
    ).toBe(true);
    expect(
      daytonaAccessNeedsRefresh(
        { providerAccessExpiresAt: "2026-07-06T12:30:00Z" },
        Date.parse("2026-07-06T12:00:00Z"),
      ),
    ).toBe(false);
  });
});
