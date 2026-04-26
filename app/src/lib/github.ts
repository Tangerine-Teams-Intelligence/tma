/**
 * GitHub OAuth device-flow client. Talks exclusively through Tauri commands
 * — there is no fetch() against api.github.com from the webview because the
 * token never crosses the IPC boundary (Rust stores it in the OS keychain).
 *
 * Standard usage:
 *
 *   const start = await ghDeviceFlowStart();
 *   show user `start.user_code` + open `start.verification_uri`
 *   const login = await ghDeviceFlowPollUntilReady(start);
 *   // token is now in the keychain; pass `login` to git commands.
 */

const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function realInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function safeInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T,
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    return await realInvoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tauri/github] invoke "${cmd}" failed:`, e);
    throw e;
  }
}

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function ghDeviceFlowStart(): Promise<DeviceFlowStart> {
  return safeInvoke("github_device_flow_start", undefined, () => ({
    device_code: "MOCK-DEVICE-CODE",
    user_code: "TANG-MOCK",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  }));
}

export interface DevicePollResult {
  state: "pending" | "slow_down" | "ready";
  login: string | null;
}

export async function ghDeviceFlowPoll(
  deviceCode: string,
): Promise<DevicePollResult> {
  return safeInvoke(
    "github_device_flow_poll",
    { args: { device_code: deviceCode } },
    () => ({ state: "ready" as const, login: "mock-user" }),
  );
}

/**
 * Poll until the OAuth grant is ready, the device code expires, or the user
 * cancels. `signal` is checked between polls so callers can abort cleanly.
 */
export async function ghDeviceFlowPollUntilReady(
  start: DeviceFlowStart,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = Math.max(2, start.interval || 5);
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    await sleep(interval * 1000);
    let r: DevicePollResult;
    try {
      r = await ghDeviceFlowPoll(start.device_code);
    } catch (e) {
      // Expired / denied / unconfigured — bubble up so the UI shows the
      // human message Rust returned.
      throw e;
    }
    if (r.state === "ready") {
      if (!r.login) throw new Error("GitHub returned no username — try again?");
      return r.login;
    }
    if (r.state === "slow_down") {
      // GitHub asks us to back off. Bump the interval per spec.
      interval += 5;
    }
  }
  throw new Error("GitHub login took too long. Try again?");
}

export interface CreateRepoResult {
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
}

export async function ghCreateRepo(args: {
  login: string;
  name?: string;
  private?: boolean;
}): Promise<CreateRepoResult> {
  return safeInvoke(
    "github_create_repo",
    {
      args: {
        login: args.login,
        name: args.name ?? null,
        private: args.private ?? true,
      },
    },
    () => ({
      name: args.name ?? "tangerine-memory-mock",
      full_name: `${args.login}/${args.name ?? "tangerine-memory-mock"}`,
      clone_url: `https://github.com/${args.login}/${args.name ?? "tangerine-memory-mock"}.git`,
      html_url: `https://github.com/${args.login}/${args.name ?? "tangerine-memory-mock"}`,
      default_branch: "main",
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
