// Lightweight Prometheus metrics primitives — zero external dependencies.

export interface ICounter {
  inc(labels?: Record<string, string>): void;
}

export interface IGauge {
  set(value: number, labels?: Record<string, string>): void;
}

export interface IHistogram {
  observe(value: number, labels?: Record<string, string>): void;
}

export interface IMetricsRegistry {
  createCounter(name: string, help: string): ICounter;
  createGauge(name: string, help: string): IGauge;
  createHistogram(name: string, help: string, buckets?: number[]): IHistogram;
  serialize(): string;
}

// --- Label helpers ---

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsKey(labels?: Record<string, string>): string {
  if (!labels) return '';
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
}

// --- Counter ---

class Counter implements ICounter {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels?: Record<string, string>): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  collect(): string {
    if (this.values.size === 0) return '';
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [key, value] of this.values) {
      const suffix = key ? `{${key}}` : '';
      lines.push(`${this.name}${suffix} ${value}`);
    }
    return lines.join('\n');
  }
}

// --- Gauge ---

class Gauge implements IGauge {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  set(value: number, labels?: Record<string, string>): void {
    this.values.set(labelsKey(labels), value);
  }

  collect(): string {
    if (this.values.size === 0) return '';
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [key, value] of this.values) {
      const suffix = key ? `{${key}}` : '';
      lines.push(`${this.name}${suffix} ${value}`);
    }
    return lines.join('\n');
  }
}

// --- Histogram ---

const DEFAULT_BUCKETS = [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];

interface HistogramEntry {
  bucketCounts: number[];
  sum: number;
  count: number;
}

class Histogram implements IHistogram {
  private readonly entries = new Map<string, HistogramEntry>();
  private readonly buckets: number[];
  constructor(readonly name: string, readonly help: string, buckets?: number[]) {
    this.buckets = buckets ?? DEFAULT_BUCKETS;
  }

  observe(value: number, labels?: Record<string, string>): void {
    const key = labelsKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { bucketCounts: new Array(this.buckets.length + 1).fill(0) as number[], sum: 0, count: 0 };
      this.entries.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i]++;
      }
    }
    entry.bucketCounts[this.buckets.length]++; // +Inf bucket
    entry.sum += value;
    entry.count++;
  }

  collect(): string {
    if (this.entries.size === 0) return '';
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [key, entry] of this.entries) {
      const baseLabels = key ? `${key},` : '';
      const suffix = key ? `{${key}}` : '';
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${baseLabels}le="${this.buckets[i]}"} ${entry.bucketCounts[i]}`);
      }
      lines.push(`${this.name}_bucket{${baseLabels}le="+Inf"} ${entry.bucketCounts[this.buckets.length]}`);
      lines.push(`${this.name}_sum${suffix} ${entry.sum}`);
      lines.push(`${this.name}_count${suffix} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

// --- Registry ---

class Registry implements IMetricsRegistry {
  private readonly metrics: { collect(): string }[] = [];

  createCounter(name: string, help: string): ICounter {
    const counter = new Counter(name, help);
    this.metrics.push(counter);
    return counter;
  }

  createGauge(name: string, help: string): IGauge {
    const gauge = new Gauge(name, help);
    this.metrics.push(gauge);
    return gauge;
  }

  createHistogram(name: string, help: string, buckets?: number[]): IHistogram {
    const histogram = new Histogram(name, help, buckets);
    this.metrics.push(histogram);
    return histogram;
  }

  serialize(): string {
    return this.metrics
      .map(m => m.collect())
      .filter(Boolean)
      .join('\n\n') + '\n';
  }
}

// --- No-op stubs ---

const noopCounter: ICounter = { inc() {} };
const noopGauge: IGauge = { set() {} };
const noopHistogram: IHistogram = { observe() {} };

class NoopRegistry implements IMetricsRegistry {
  createCounter(): ICounter { return noopCounter; }
  createGauge(): IGauge { return noopGauge; }
  createHistogram(): IHistogram { return noopHistogram; }
  serialize(): string { return ''; }
}

// --- Factory ---

export function createMetricsRegistry(enabled: boolean): IMetricsRegistry {
  return enabled ? new Registry() : new NoopRegistry();
}
