import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRunService } from "../src/api-contracts.js";
export async function tempRoot(label: string): Promise<string> { return mkdtemp(join(tmpdir(), `fieldwork-${label}-`)); }

export function apiFetch(service: OpenRunService, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-fieldwork-capability", service.capabilityToken);
  if (init.method && init.method !== "GET") headers.set("origin", service.baseUrl);
  return fetch(`${service.baseUrl}${path}`, { ...init, headers });
}
