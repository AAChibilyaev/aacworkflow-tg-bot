/** Tiny token-scoped AACWorkflow REST client. Each call uses one customer's token. */
export const serverUrl = (process.env.AACWORKFLOW_SERVER_URL ?? "https://aacworkflow.com").replace(/\/+$/, "");

type Opts = { workspaceId?: string; query?: Record<string, string | undefined>; body?: unknown };

export async function aac(token: string, method: string, path: string, opts: Opts = {}): Promise<any> {
  const url = new URL(serverUrl + path);
  if (opts.workspaceId) url.searchParams.set("workspace_id", opts.workspaceId);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/** Resolve which workspace to act on: stored choice → the only one → ask. */
export async function resolveWorkspace(token: string, stored?: string): Promise<string> {
  if (stored) return stored;
  const data = await aac(token, "GET", "/api/workspaces");
  const arr: any[] = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
  if (arr.length === 1) return arr[0].id;
  if (arr.length === 0) throw new Error("У этого ключа нет рабочих пространств.");
  throw new Error("У тебя несколько компаний — выбери: /use <id>\n" + arr.map((w) => `• ${w.name} — \`${w.id}\``).join("\n"));
}
