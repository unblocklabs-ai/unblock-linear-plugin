import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LinearUploadError,
  MAX_LINEAR_UPLOAD_BYTES,
  executeManagedUpload,
  linearFileUploadGraphqlInput,
  type ManagedMedia,
  type ManagedUploadDependencies,
} from "../src/linear/upload.js";
import { RelayJournal } from "../src/relay/journal.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "unblock-linear-upload-"));
  return RelayJournal.open(join(directory, "relay.json"));
}

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function uploadResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      fileUpload: {
        success: true,
        uploadFile: {
          uploadUrl: "https://uploads.linear.app/signed?opaque=1",
          assetUrl: "https://uploads.linear.app/asset/opaque",
          headers: [
            { key: "x-linear-upload", value: "opaque" },
          ],
          ...overrides,
        },
      },
    },
  };
}

async function dependencies(
  media: ManagedMedia,
  response: unknown = uploadResponse(),
): Promise<ManagedUploadDependencies & { journal: RelayJournal }> {
  const journal = await fixture();
  return {
    journal,
    workflows: journal,
    media: { resolve: vi.fn(async () => media) },
    requestFileUpload: vi.fn(async () => response),
    fetch: { put: vi.fn(async () => ({ status: 200 })) },
    now: () => "2026-08-12T12:00:00.000Z",
  };
}

const input = {
  toolCallId: "tool-upload-1",
  ownerId: "opaque-context",
  fileRef: "media://inbound/opaque_1",
} as const;

describe("managed Linear upload", () => {
  it.each([
    "/private/file.txt",
    "relative/file.txt",
    "file:///private/file.txt",
    "https://example.com/file.txt",
    "data:text/plain,secret",
    "media://inbound/contains/slash",
  ])("rejects non-managed source %s without invoking host or network capabilities", async (fileRef) => {
    const deps = await dependencies({ size: 1, stream: async () => stream(new Uint8Array([1])) });

    await expect(executeManagedUpload({ ...input, fileRef }, deps))
      .rejects.toMatchObject({ code: "invalid_source" });
    expect(deps.media.resolve).not.toHaveBeenCalled();
    expect(deps.requestFileUpload).not.toHaveBeenCalled();
    expect(deps.fetch.put).not.toHaveBeenCalled();
  });

  it("accepts the filename and extension form produced by OpenClaw's managed media store", async () => {
    const deps = await dependencies({
      size: 1,
      stream: async () => stream(new Uint8Array([1])),
    });

    await expect(executeManagedUpload({
      ...input,
      fileRef: "media://inbound/proof---05197874-4019-4dcf-bc13-686af0978997.txt",
    }, deps)).resolves.toEqual({ assetUrl: "https://uploads.linear.app/asset/opaque" });
    expect(deps.media.resolve).toHaveBeenCalledWith(
      "media://inbound/proof---05197874-4019-4dcf-bc13-686af0978997.txt",
    );
  });

  it("rejects a managed file over 25 MiB before requesting an upload destination", async () => {
    const deps = await dependencies({
      size: MAX_LINEAR_UPLOAD_BYTES + 1,
      stream: async () => { throw new Error("must not stream"); },
    });

    await expect(executeManagedUpload(input, deps)).rejects.toMatchObject({ code: "too_large" });
    expect(deps.requestFileUpload).not.toHaveBeenCalled();
    expect(deps.fetch.put).not.toHaveBeenCalled();
  });

  it("copies returned headers and supplies the approved content type and exact stream length", async () => {
    const sourceChunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])];
    const deps = await dependencies({
      size: 6,
      filename: "host-name.txt",
      contentType: "text/plain",
      stream: vi.fn(async () => stream(...sourceChunks)),
    });
    vi.mocked(deps.fetch.put).mockImplementation(async (request) => {
      expect(request).toMatchObject({
        url: "https://uploads.linear.app/signed?opaque=1",
        redirect: "error",
        headers: {
          "x-linear-upload": "opaque",
          "Content-Type": "text/plain",
          "Content-Length": "6",
        },
      });
      expect(Object.keys(request.headers)).toEqual(["x-linear-upload", "Content-Type", "Content-Length"]);
      const reader = request.body.getReader();
      const received: number[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received.push(...chunk.value);
      }
      expect(received).toEqual([1, 2, 3, 4, 5, 6]);
      return { status: 200 };
    });

    await expect(executeManagedUpload(input, deps)).resolves.toEqual({
      assetUrl: "https://uploads.linear.app/asset/opaque",
    });
    const request = vi.mocked(deps.requestFileUpload).mock.calls[0][0];
    expect(request).toMatchObject({
      contentType: "text/plain",
      filename: "host-name.txt",
      size: 6,
    });
    expect(request.invocationId).toMatch(/^upload_[A-Za-z0-9_-]{43}:graphql$/u);
    expect(linearFileUploadGraphqlInput(request)).toMatchObject({
      action: "graphql",
      operationName: "UnblockLinearFileUpload",
      variables: { contentType: "text/plain", filename: "host-name.txt", size: 6 },
    });
    expect(deps.journal.snapshot().uploads[Object.keys(deps.journal.snapshot().uploads)[0] ?? ""])
      .toMatchObject({ status: "completed", bytesSent: 6, assetUrl: "https://uploads.linear.app/asset/opaque" });
  });

  it.each([
    { uploadUrl: "http://uploads.linear.app/insecure" },
    { uploadUrl: "https://user:password@uploads.linear.app/signed" },
    { uploadUrl: "https://uploads.linear.app/signed#not-sent-in-http" },
    { assetUrl: "http://uploads.linear.app/insecure-asset" },
  ])("rejects unsafe upload response URLs", async (override) => {
    const deps = await dependencies(
      { size: 1, stream: async () => stream(new Uint8Array([1])) },
      uploadResponse(override),
    );

    await expect(executeManagedUpload(input, deps))
      .rejects.toMatchObject({ code: "invalid_upload_response" });
    expect(deps.fetch.put).not.toHaveBeenCalled();
  });

  it.each([
    { headers: [{ key: "X-Test", value: "ok\r\nInjected: bad" }] },
    { headers: [{ key: "X-Test", value: "one" }, { key: "x-test", value: "two" }] },
    { headers: [{ key: "Bad Header", value: "bad" }] },
    { headers: Array.from({ length: 33 }, (_, index) => ({ key: `X-Test-${index}`, value: "value" })) },
  ])("rejects invalid or ambiguous returned headers", async ({ headers }) => {
    const deps = await dependencies(
      { size: 1, stream: async () => stream(new Uint8Array([1])) },
      uploadResponse({ headers }),
    );

    await expect(executeManagedUpload(input, deps))
      .rejects.toMatchObject({ code: "invalid_upload_response" });
    expect(deps.fetch.put).not.toHaveBeenCalled();
  });

  it("marks a started PUT ambiguous and never replays it automatically", async () => {
    const deps = await dependencies({
      size: 1,
      stream: async () => stream(new Uint8Array([1])),
    });
    vi.mocked(deps.fetch.put).mockRejectedValueOnce(new Error("connection reset after dispatch"));

    await expect(executeManagedUpload(input, deps)).rejects.toMatchObject({
      code: "upload_ambiguous",
      reconciliationRequired: true,
    });
    expect(Object.values(deps.journal.snapshot().uploads)[0]).toMatchObject({ status: "ambiguous" });
    await expect(executeManagedUpload(input, deps)).rejects.toMatchObject({ code: "upload_ambiguous" });
    expect(deps.requestFileUpload).toHaveBeenCalledTimes(1);
    expect(deps.fetch.put).toHaveBeenCalledTimes(1);
  });

  it("fails ambiguous if the host stream differs from the approved size", async () => {
    const deps = await dependencies({
      size: 1,
      stream: async () => stream(new Uint8Array([1, 2])),
    });
    vi.mocked(deps.fetch.put).mockImplementation(async ({ body }) => {
      const reader = body.getReader();
      while (!(await reader.read()).done) { /* consume */ }
      return { status: 200 };
    });

    await expect(executeManagedUpload(input, deps))
      .rejects.toMatchObject({ code: "upload_ambiguous", reconciliationRequired: true });
    expect(Object.values(deps.journal.snapshot().uploads)[0]).toMatchObject({ status: "ambiguous" });
  });

  it("treats a non-success PUT response as ambiguous and does not follow redirects", async () => {
    const deps = await dependencies({ size: 1, stream: async () => stream(new Uint8Array([1])) });
    vi.mocked(deps.fetch.put).mockResolvedValueOnce({ status: 307 });

    await expect(executeManagedUpload(input, deps)).rejects.toBeInstanceOf(LinearUploadError);
    expect(vi.mocked(deps.fetch.put).mock.calls[0][0].redirect).toBe("error");
    expect(Object.values(deps.journal.snapshot().uploads)[0]).toMatchObject({ status: "ambiguous" });
  });
});
