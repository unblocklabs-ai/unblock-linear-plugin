import { createHash } from "node:crypto";
import type { RelayJournal } from "../relay/journal.js";
import { managedMediaId } from "./media-ref.js";

export const MAX_LINEAR_UPLOAD_BYTES = 25 * 1024 * 1024;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 4_096;
const MAX_HEADER_BYTES = 16 * 1024;
const UTF8 = new TextEncoder();

export type ManagedMedia = {
  size: number;
  filename?: string;
  contentType?: string;
  stream(): Promise<ReadableStream<Uint8Array>>;
};

/** Must resolve only host-approved managed refs; never accept paths or URLs. */
export interface ManagedMediaPort {
  resolve(fileRef: string): Promise<ManagedMedia>;
}

export type UploadPutRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: ReadableStream<Uint8Array>;
  redirect: "error";
  signal?: AbortSignal;
};

export interface UploadFetch {
  put(request: UploadPutRequest): Promise<{ status: number }>;
}

export type UploadWorkflowPort = Pick<
  RelayJournal,
  "getUpload" | "recordUpload" | "updateUpload"
>;

export type FileUploadRequest = {
  invocationId: string;
  contentType: string;
  filename: string;
  size: number;
  signal?: AbortSignal;
};

export type ManagedUploadDependencies = {
  media: ManagedMediaPort;
  fetch: UploadFetch;
  workflows: UploadWorkflowPort;
  requestFileUpload(request: FileUploadRequest): Promise<unknown>;
  now?: () => string;
};

export type ManagedUploadInput = {
  toolCallId: string;
  ownerId: string;
  deliveryId?: string;
  sessionId?: string;
  fileRef: string;
  filename?: string;
  contentType?: string;
  signal?: AbortSignal;
};

export class LinearUploadError extends Error {
  constructor(
    readonly code:
      | "invalid_source"
      | "invalid_media"
      | "too_large"
      | "invalid_upload_response"
      | "upload_ambiguous",
    message: string,
    readonly reconciliationRequired = false,
  ) {
    super(message);
    this.name = "LinearUploadError";
  }
}

const FILE_UPLOAD_DOCUMENT = `mutation UnblockLinearFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile {
      uploadUrl
      assetUrl
      headers { key value }
    }
  }
}`;

export async function executeManagedUpload(
  input: ManagedUploadInput,
  dependencies: ManagedUploadDependencies,
): Promise<{ assetUrl: string }> {
  if (managedMediaId(input.fileRef) === undefined) throw invalidSource();
  const uploadId = stableUploadId(input.toolCallId);
  const prior = dependencies.workflows.getUpload(uploadId);
  if (prior !== undefined && (prior.ownerId !== input.ownerId ||
    prior.deliveryId !== input.deliveryId || prior.sessionId !== input.sessionId ||
    prior.fileRef !== input.fileRef)) {
    throw invalidMedia();
  }
  if (prior?.status === "completed" && prior.assetUrl !== undefined) {
    return { assetUrl: prior.assetUrl };
  }
  if (prior?.status === "uploading" || prior?.status === "ambiguous") throw ambiguous();
  if (prior?.status === "failed") throw invalidMedia();

  let media: ManagedMedia;
  try {
    media = await dependencies.media.resolve(input.fileRef);
  } catch {
    throw invalidSource();
  }
  if (!Number.isSafeInteger(media.size) || media.size < 0) throw invalidMedia();
  if (media.size > MAX_LINEAR_UPLOAD_BYTES) {
    throw new LinearUploadError("too_large", "The managed file exceeds the 25 MiB Linear upload limit.");
  }
  const filename = boundedMetadata(input.filename ?? media.filename ?? "upload", 512);
  const contentType = boundedMetadata(input.contentType ?? media.contentType ?? "application/octet-stream", 256);
  const recordedAt = dependencies.now?.() ?? new Date().toISOString();
  if (prior === undefined) {
    await dependencies.workflows.recordUpload({
      uploadId,
      ownerId: input.ownerId,
      ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      fileRef: input.fileRef,
      filename,
      contentType,
      status: "pending",
      recordedAt,
    });
  } else if (prior.filename !== filename || prior.contentType !== contentType) {
    throw invalidMedia();
  }

  const graphqlResult = await dependencies.requestFileUpload({
    invocationId: `${uploadId}:graphql`,
    contentType,
    filename,
    size: media.size,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const destination = parseFileUploadResult(graphqlResult);
  await dependencies.workflows.updateUpload(uploadId, {
    status: "uploading",
    destination: destination.uploadUrl,
  });

  let response: { status: number };
  try {
    const source = await media.stream();
    response = await dependencies.fetch.put({
      url: destination.uploadUrl,
      headers: uploadHeaders(destination.headers, contentType, media.size),
      body: boundedStream(source, media.size),
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    await markAmbiguous(dependencies.workflows, uploadId);
    throw ambiguous();
  }
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    await markAmbiguous(dependencies.workflows, uploadId);
    throw ambiguous();
  }

  await dependencies.workflows.updateUpload(uploadId, {
    status: "completed",
    bytesSent: media.size,
    assetUrl: destination.assetUrl,
  });
  return { assetUrl: destination.assetUrl };
}

function uploadHeaders(
  returned: Readonly<Record<string, string>>,
  contentType: string,
  size: number,
): Readonly<Record<string, string>> {
  const headers = { ...returned };
  setRequiredUploadHeader(headers, "Content-Type", contentType);
  setRequiredUploadHeader(headers, "Content-Length", String(size));
  return headers;
}

function setRequiredUploadHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const existingName = Object.keys(headers).find((candidate) =>
    candidate.toLowerCase() === name.toLowerCase());
  if (existingName !== undefined) {
    if (headers[existingName] !== value) throw invalidResponse();
    return;
  }
  headers[name] = value;
}

export function linearFileUploadGraphqlInput(request: FileUploadRequest): {
  action: "graphql";
  operationName: "UnblockLinearFileUpload";
  document: string;
  variables: { contentType: string; filename: string; size: number };
} {
  return {
    action: "graphql",
    operationName: "UnblockLinearFileUpload",
    document: FILE_UPLOAD_DOCUMENT,
    variables: {
      contentType: request.contentType,
      filename: request.filename,
      size: request.size,
    },
  };
}

function parseFileUploadResult(value: unknown): {
  uploadUrl: string;
  assetUrl: string;
  headers: Readonly<Record<string, string>>;
} {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.fileUpload)) {
    throw invalidResponse();
  }
  const payload = value.data.fileUpload;
  if (payload.success !== true || !isRecord(payload.uploadFile) ||
    (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0))) {
    throw invalidResponse();
  }
  const uploadUrl = parseHttpsUrl(payload.uploadFile.uploadUrl);
  const assetUrl = parseHttpsUrl(payload.uploadFile.assetUrl);
  return {
    uploadUrl,
    assetUrl,
    headers: parseHeaders(payload.uploadFile.headers),
  };
}

function parseHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) throw invalidResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw invalidResponse();
  }
  return value;
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) throw invalidResponse();
  const headers = new Map<string, [string, string]>();
  let totalBytes = 0;
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 ||
      typeof entry.key !== "string" || typeof entry.value !== "string" ||
      !HEADER_NAME.test(entry.key) || /[\r\n]/u.test(entry.value)) throw invalidResponse();
    const nameBytes = UTF8.encode(entry.key).byteLength;
    const valueBytes = UTF8.encode(entry.value).byteLength;
    if (nameBytes > MAX_HEADER_NAME_BYTES || valueBytes > MAX_HEADER_VALUE_BYTES) throw invalidResponse();
    totalBytes += nameBytes + valueBytes;
    const canonical = entry.key.toLowerCase();
    if (headers.has(canonical) || totalBytes > MAX_HEADER_BYTES) throw invalidResponse();
    headers.set(canonical, [entry.key, entry.value]);
  }
  return Object.fromEntries([...headers.values()]);
}

function boundedStream(source: ReadableStream<Uint8Array>, expectedSize: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let bytesRead = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        if (bytesRead !== expectedSize) controller.error(invalidMedia());
        else controller.close();
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        controller.error(invalidMedia());
        await reader.cancel();
        return;
      }
      bytesRead += next.value.byteLength;
      if (bytesRead > expectedSize || bytesRead > MAX_LINEAR_UPLOAD_BYTES) {
        controller.error(new LinearUploadError("too_large", "The managed file exceeds the 25 MiB Linear upload limit."));
        await reader.cancel();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function stableUploadId(toolCallId: string): string {
  if (toolCallId.length < 1) throw invalidMedia();
  return `upload_${createHash("sha256").update("unblock-linear-upload-v1\0").update(toolCallId).digest("base64url")}`;
}

function boundedMetadata(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) throw invalidMedia();
  return value;
}

async function markAmbiguous(workflows: UploadWorkflowPort, uploadId: string): Promise<void> {
  await workflows.updateUpload(uploadId, { status: "ambiguous" });
}

function invalidSource(): LinearUploadError {
  return new LinearUploadError("invalid_source", "Only an OpenClaw-approved managed media reference can be uploaded.");
}

function invalidMedia(): LinearUploadError {
  return new LinearUploadError("invalid_media", "The managed file is not valid for Linear upload.");
}

function invalidResponse(): LinearUploadError {
  return new LinearUploadError("invalid_upload_response", "Linear did not return a valid upload destination.");
}

function ambiguous(): LinearUploadError {
  return new LinearUploadError(
    "upload_ambiguous",
    "The Linear upload outcome is unknown. Reconcile the asset before attempting another upload.",
    true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
