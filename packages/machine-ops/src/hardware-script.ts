/**
 * Portable sh script that prints a hardware snapshot (CPU, memory, disks, temperatures,
 * GPU, top processes) on Linux or macOS. Parsing stays on the server (system/hardware.ts);
 * this file only carries the script text so the agent can embed it verbatim.
 */

const LINUX = [
  `echo "OS:linux"`,
  `echo "HOST:$(hostname 2>/dev/null)"`,
  `echo "CPUMODEL:$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"`,
  `echo "NCPU:$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"`,
  `echo "UPTIME:$(cut -d' ' -f1 /proc/uptime)"`,
  `echo "LOAD:$(cut -d' ' -f1-3 /proc/loadavg)"`,
  `echo "STAT1:$(head -1 /proc/stat)"`,
  `sleep 1`,
  `echo "STAT2:$(head -1 /proc/stat)"`,
  `grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo | sed 's/^/MEM:/'`,
  `df -Pk 2>/dev/null | tail -n +2 | awk '{ for (i = 6; i <= NF; i++) if ($i ~ /^\\//) { m = $i; for (j = i + 1; j <= NF; j++) m = m " " $j; printf "DISK:%s\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, $3, $4, m; break } }'`,
  `for z in /sys/class/thermal/thermal_zone*; do [ -f "$z/temp" ] && printf 'TEMP:%s\\t%s\\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done`,
  `for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); for t in "$h"/temp*_input; do [ -f "$t" ] && printf 'TEMP:%s\\t%s\\n' "$n $(cat "\${t%_input}_label" 2>/dev/null)" "$(cat "$t" 2>/dev/null)"; done; done`,
  `command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/GPU:/'`,
  `ps -eo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | tail -n +2 | head -7 | sed 's/^ *//;s/^/PROC:/'`,
  `exit 0`,
].join('; ');

const DARWIN = [
  `echo "OS:macos"`,
  `echo "HOST:$(hostname 2>/dev/null)"`,
  `echo "CPUMODEL:$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"`,
  `echo "NCPU:$(sysctl -n hw.ncpu)"`,
  `echo "BOOT:$(sysctl -n kern.boottime | sed 's/^{ sec = \\([0-9]*\\),.*/\\1/')"`,
  `echo "NOW:$(date +%s)"`,
  `echo "LOAD:$(sysctl -n vm.loadavg | tr -d '{}')"`,
  `echo "MEMSIZE:$(sysctl -n hw.memsize)"`,
  `vm_stat | sed 's/^/VMSTAT:/'`,
  `echo "SWAPUSAGE:$(sysctl -n vm.swapusage)"`,
  `top -l 2 -s 1 -n 0 2>/dev/null | grep 'CPU usage' | tail -1 | sed 's/^/CPUUSAGE:/'`,
  `df -Pk 2>/dev/null | tail -n +2 | awk '{ for (i = 6; i <= NF; i++) if ($i ~ /^\\//) { m = $i; for (j = i + 1; j <= NF; j++) m = m " " $j; printf "DISK:%s\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, $3, $4, m; break } }'`,
  `ps -A -o pcpu,pmem,comm -r 2>/dev/null | tail -n +2 | head -7 | sed 's/^ *//;s/^/PROC:/'`,
  `exit 0`,
].join('; ');

export const HARDWARE_SCRIPT = `if [ "$(uname -s)" = Darwin ]; then ${DARWIN}; else ${LINUX}; fi`;
