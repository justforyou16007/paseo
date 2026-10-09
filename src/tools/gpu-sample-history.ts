export interface GpuSample {
  gpu_index: number;
  used_mib: number;
  total_mib: number;
  ts: number;
}

export interface GpuStats {
  gpu_index: number;
  avg_used_mib: number;
  avg_free_mib: number;
  avg_util_pct: number;
  sample_count: number;
}

export class GpuSampleHistory {
  private samples: GpuSample[] = [];

  constructor(private windowMs: number = 5 * 60 * 1000) {}

  add(newSamples: GpuSample[]): void {
    this.samples.push(...newSamples);
    this.prune();
  }

  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
  }

  statsFor(gpuIndex: number): GpuStats | null {
    const relevant = this.samples.filter((s) => s.gpu_index === gpuIndex);
    if (relevant.length === 0) return null;
    const avgUsed = relevant.reduce((sum, s) => sum + s.used_mib, 0) / relevant.length;
    const avgTotal = relevant.reduce((sum, s) => sum + s.total_mib, 0) / relevant.length;
    const avgFree = avgTotal - avgUsed;
    const avgUtil = avgTotal > 0 ? (avgUsed / avgTotal) * 100 : 0;
    return {
      gpu_index: gpuIndex,
      avg_used_mib: Math.round(avgUsed),
      avg_free_mib: Math.round(avgFree),
      avg_util_pct: Math.round(avgUtil * 10) / 10,
      sample_count: relevant.length,
    };
  }

  allStats(): GpuStats[] {
    const indices = [...new Set(this.samples.map((s) => s.gpu_index))];
    return indices.map((i) => this.statsFor(i)).filter((s): s is GpuStats => s !== null);
  }
}
