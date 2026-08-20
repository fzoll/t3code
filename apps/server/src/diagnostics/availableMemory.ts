// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Kernel-aware available memory — not just "free" pages.
 * Linux: MemAvailable from /proc/meminfo.
 * macOS: vm_stat free + inactive + speculative + purgeable.
 * Fallback: os.freemem() (understates on both platforms).
 *
 * The platform is passed in rather than read from `node:os` so Effect callers
 * resolve it through `HostProcessPlatform` and tests can pin it.
 */
export function availableMemoryMb(platform: NodeJS.Platform): number {
  if (platform === "linux") {
    try {
      const meminfo = NodeFS.readFileSync("/proc/meminfo", "utf8");
      const match = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (match?.[1]) return Math.round(parseInt(match[1]) / 1024);
    } catch {}
  }

  if (platform === "darwin") {
    try {
      const vmstat = NodeChildProcess.execSync("vm_stat", { encoding: "utf8" });
      const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch?.[1] ? parseInt(pageSizeMatch[1]) : 16384;
      const page = (key: string) => {
        const m = vmstat.match(new RegExp(`Pages ${key}:\\s+(\\d+)`));
        return m?.[1] ? parseInt(m[1]) : 0;
      };
      const bytes =
        (page("free") + page("inactive") + page("speculative") + page("purgeable")) * pageSize;
      return Math.round(bytes / 1024 / 1024);
    } catch {}
  }

  return Math.round(NodeOS.freemem() / 1024 / 1024);
}
