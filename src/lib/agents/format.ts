/** Date and time of a run or queue, Dutch: "28/10 17:27". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "45 s", "12 min", "1 u 05 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} u ${String(minutes % 60).padStart(2, "0")} min`;
}
