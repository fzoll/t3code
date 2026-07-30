import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Kernel-aware available memory — not just "free" pages.
 * Linux: MemAvailable from /proc/meminfo.
 * macOS: vm_stat free + inactive + speculative + purgeable.
 * Fallback: os.freemem() (understates on both platforms).
 */
export function availableMemoryMb(): number {
  if (os.platform() === "linux") {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const match = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (match?.[1]) return Math.round(parseInt(match[1]) / 1024);
    } catch {}
  }

  if (os.platform() === "darwin") {
    try {
      const vmstat = execSync("vm_stat", { encoding: "utf8" });
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

  return Math.round(os.freemem() / 1024 / 1024);
}
