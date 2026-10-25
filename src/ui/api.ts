const TOKEN_KEY = "envidence.session.token";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function readSessionToken(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/^#token=([A-Za-z0-9._-]+)/);
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    const clean = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", `${clean}#/`);
    return match[1];
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearSessionToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new ApiError("Dashboard session token is missing.", 401);
  const headers = new Headers(init.headers);
  headers.set("X-Envidence-Token", token);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status text.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export async function downloadCaseReport(caseId: string, redaction = "standard"): Promise<void> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new ApiError("Dashboard session token is missing.", 401);
  const response = await fetch(
    `/api/report?case=${encodeURIComponent(caseId)}&redact=${encodeURIComponent(redaction)}`,
    { headers: { "X-Envidence-Token": token }, cache: "no-store" },
  );
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status text.
    }
    throw new ApiError(message, response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `envidence-${caseId}.html`;
  link.click();
  URL.revokeObjectURL(url);
}
