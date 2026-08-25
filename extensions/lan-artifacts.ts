import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_HTML_BYTES = 16 * 1024 * 1024;

function serverUrl(): string {
  const value = process.env.LAN_ARTIFACT_SERVER || "http://127.0.0.1:4173";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LAN_ARTIFACT_SERVER must use http or https");
  }
  return url.href.replace(/\/$/, "");
}

function writeToken(): string {
  const token = process.env.LAN_ARTIFACT_WRITE_TOKEN;
  if (!token) throw new Error("LAN_ARTIFACT_WRITE_TOKEN is not set");
  return token;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(serverUrl() + path, {
    method,
    signal: combinedSignal,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-artifact-write-token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  if (!response.ok) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "artifact_publish",
    label: "Publish artifact",
    description:
      "Publish a self-contained HTML artifact to the configured LAN server. " +
      "Creates a new artifact unless artifactId is explicitly supplied. " +
      "Never include secrets or confidential data. Maximum HTML size: 16 MiB.",
    parameters: Type.Object({
      html: Type.String({ description: "Self-contained HTML with inline CSS, JS, and assets" }),
      title: Type.Optional(Type.String({ description: "Artifact title" })),
      emoji: Type.Optional(Type.String({ description: "Browser-tab emoji" })),
      artifactId: Type.Optional(Type.String({ description: "Existing artifact ID to update" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (Buffer.byteLength(params.html, "utf8") > MAX_HTML_BYTES) {
        throw new Error("Artifact HTML exceeds the 16 MiB limit");
      }
      const body: Record<string, unknown> = { html: params.html };
      if (params.title !== undefined) body.title = params.title;
      if (params.emoji !== undefined) body.emoji = params.emoji;
      const data = params.artifactId
        ? await request(
            "POST",
            `/api/artifacts/${encodeURIComponent(params.artifactId)}/versions`,
            body,
            writeToken(),
            signal,
          )
        : await request("POST", "/api/artifacts", body, writeToken(), signal);
      return result(data);
    },
  });

  pi.registerTool({
    name: "artifact_list",
    label: "List artifacts",
    description: "List artifacts from the configured LAN Artifacts server.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return result(await request("GET", "/api/artifacts", undefined, undefined, signal));
    },
  });

  pi.registerTool({
    name: "artifact_get",
    label: "Get artifact",
    description: "Get metadata and versions for one LAN artifact.",
    parameters: Type.Object({
      artifactId: Type.String({ description: "Artifact ID" }),
    }),
    async execute(_toolCallId, params, signal) {
      return result(
        await request(
          "GET",
          `/api/artifacts/${encodeURIComponent(params.artifactId)}`,
          undefined,
          undefined,
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "artifact_delete",
    label: "Delete artifact",
    description: "Permanently delete one LAN artifact after interactive human confirmation.",
    parameters: Type.Object({
      artifactId: Type.String({ description: "Artifact ID" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("artifact_delete requires an interactive Pi session");
      }
      const confirmed = await ctx.ui.confirm(
        "Delete LAN artifact?",
        `Permanently delete ${params.artifactId} and every version?`,
      );
      if (!confirmed) throw new Error("Artifact deletion cancelled");
      await request(
        "DELETE",
        `/api/artifacts/${encodeURIComponent(params.artifactId)}`,
        undefined,
        writeToken(),
        signal,
      );
      return result({ deleted: true, artifactId: params.artifactId });
    },
  });
}
