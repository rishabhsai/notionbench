/**
 * Scoring statistics for NotionBench.
 *
 * NotionBench runs k independent trials per (task, config, docs condition) and
 * reports discovery (avg@k) separately from reliability (pass^k) — see
 * docs/PLAN.md, "Retry policy".
 */

/** Number of k-subsets of an n-set. Exact for the sizes we use (k <= n <= ~50). */
export function combinations(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k)) throw new RangeError("n and k must be integers")
  if (k < 0 || n < 0 || k > n) return 0
  const kk = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1)
  }
  return Math.round(result)
}

/**
 * pass^k — the unbiased tau-bench estimator: the probability that k trials
 * drawn without replacement from the n observed trials all succeeded.
 *
 *     pass^k = C(c, k) / C(n, k)
 *
 * with `c` the number of successful trials out of `n`. `pass^k = 1` means the
 * task was solved in every trial; `0` means fewer than k trials succeeded.
 */
export function passHatK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) {
    throw new RangeError("passHatK expects integer arguments")
  }
  if (n <= 0) throw new RangeError("passHatK requires n > 0")
  if (c < 0 || c > n) throw new RangeError(`passHatK requires 0 <= c <= n (got c=${c}, n=${n})`)
  if (k < 1 || k > n) throw new RangeError(`passHatK requires 1 <= k <= n (got k=${k}, n=${n})`)
  if (c < k) return 0
  // Product form of C(c,k)/C(n,k): numerically stable, no large factorials.
  let p = 1
  for (let i = 0; i < k; i++) {
    p *= (c - i) / (n - i)
  }
  return p
}

export interface WilsonInterval {
  /** Observed proportion, successes / n. */
  point: number
  /** Wilson score centre (shrunk towards 1/2). */
  center: number
  low: number
  high: number
  /** Half-width of the interval around `center`. */
  margin: number
  z: number
}

/**
 * Wilson score interval for a binomial proportion — the CI reported alongside
 * every avg@k number. Defaults to z = 1.96 (95%).
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval {
  if (n < 0 || successes < 0 || successes > n) {
    throw new RangeError(`wilsonInterval requires 0 <= successes <= n (got ${successes}/${n})`)
  }
  if (n === 0) return { point: 0, center: 0.5, low: 0, high: 1, margin: 0.5, z }
  const p = successes / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return {
    point: p,
    center,
    low: clamp01(center - margin),
    high: clamp01(center + margin),
    margin,
    z,
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Mean score over the first `k` trials (avg@k). */
export function avgAtK(scores: readonly number[], k: number = scores.length): number {
  if (k < 1) throw new RangeError("avgAtK requires k >= 1")
  if (k > scores.length) {
    throw new RangeError(`avgAtK requires k <= trials (got k=${k}, trials=${scores.length})`)
  }
  let total = 0
  for (let i = 0; i < k; i++) total += scores[i]
  return total / k
}

/** One task's trial scores under a single (config, docs condition) cell. */
export interface TaskTrials {
  taskId: string
  /** Grouping key for the per-family breakdown (`cli` | `workers` | `nac` | `ops`). */
  family: string
  /** Per-trial scores in [0,1]. */
  scores: readonly number[]
}

export interface AggregateOptions {
  /** Trials to consider per task; defaults to the smallest trial count present. */
  k?: number
  /** Score at or above which a trial counts as solved (default 1). */
  threshold?: number
  /** z for the Wilson interval (default 1.96). */
  z?: number
}

export interface AggregateStats {
  tasks: number
  /** Trials counted (`tasks * k`). */
  trials: number
  k: number
  /** Macro-average over tasks of avg@k — one row per task, tasks weighted equally. */
  avgScore: number
  /** Trials whose score met the solve threshold. */
  solved: number
  /** solved / trials. */
  solveRate: number
  /** Wilson CI on `solveRate`. */
  ci: WilsonInterval
  /** Macro-average over tasks of pass^k. */
  passHatK: number
}

export interface AggregateResult {
  overall: AggregateStats
  byFamily: Record<string, AggregateStats>
  /** Per-task detail, sorted by task id. */
  byTask: Array<{ taskId: string; family: string; avgScore: number; solved: number; passHatK: number }>
}

const EPS = 1e-9

/**
 * Aggregate per-task trial scores into the numbers the report needs, overall
 * and grouped by family.
 */
export function aggregateTrials(
  entries: readonly TaskTrials[],
  opts: AggregateOptions = {},
): AggregateResult {
  const threshold = opts.threshold ?? 1
  const z = opts.z ?? 1.96
  if (entries.length === 0) {
    const empty = emptyStats(opts.k ?? 0, z)
    return { overall: empty, byFamily: {}, byTask: [] }
  }
  const minTrials = Math.min(...entries.map((e) => e.scores.length))
  const k = opts.k ?? minTrials
  if (k < 1) throw new RangeError("aggregateTrials requires at least one trial per task")
  for (const entry of entries) {
    if (entry.scores.length < k) {
      throw new RangeError(
        `task "${entry.taskId}" has ${entry.scores.length} trials, fewer than k=${k}`,
      )
    }
    for (const score of entry.scores) {
      if (!(score >= 0 && score <= 1)) {
        throw new RangeError(`task "${entry.taskId}" has an out-of-range score: ${score}`)
      }
    }
  }

  const byTask = entries
    .map((entry) => {
      const scores = entry.scores.slice(0, k)
      const solved = scores.filter((s) => s >= threshold - EPS).length
      return {
        taskId: entry.taskId,
        family: entry.family,
        avgScore: avgAtK(scores, k),
        solved,
        passHatK: passHatK(k, solved, k),
      }
    })
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))

  const families = new Map<string, typeof byTask>()
  for (const task of byTask) {
    const list = families.get(task.family) ?? []
    list.push(task)
    families.set(task.family, list)
  }

  const byFamily: Record<string, AggregateStats> = {}
  for (const family of [...families.keys()].sort()) {
    byFamily[family] = summarize(families.get(family)!, k, z)
  }
  return { overall: summarize(byTask, k, z), byFamily, byTask }
}

function summarize(
  tasks: Array<{ avgScore: number; solved: number; passHatK: number }>,
  k: number,
  z: number,
): AggregateStats {
  const trials = tasks.length * k
  const solved = tasks.reduce((acc, t) => acc + t.solved, 0)
  return {
    tasks: tasks.length,
    trials,
    k,
    avgScore: mean(tasks.map((t) => t.avgScore)),
    solved,
    solveRate: trials === 0 ? 0 : solved / trials,
    ci: wilsonInterval(solved, trials, z),
    passHatK: mean(tasks.map((t) => t.passHatK)),
  }
}

function emptyStats(k: number, z: number): AggregateStats {
  return {
    tasks: 0,
    trials: 0,
    k,
    avgScore: 0,
    solved: 0,
    solveRate: 0,
    ci: wilsonInterval(0, 0, z),
    passHatK: 0,
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
