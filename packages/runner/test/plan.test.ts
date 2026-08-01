import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { buildPlan, renderPlan, type BuildPlanOptions } from '../src/plan.js';
import type { TaskSpec } from '../src/types.js';

const tasks: TaskSpec[] = [
  {
    id: 'build-nac-001-workspace-from-spec',
    dir: '/repo/evals/build-nac-001-workspace-from-spec',
    promptPath: '/repo/evals/build-nac-001-workspace-from-spec/PROMPT.md',
    family: 'nac',
    stage: 'build',
    runtime: 'offline',
    limits: { time: 900 },
  },
  {
    id: 'operate-batch-001-rate-limited-writes',
    dir: '/repo/evals/operate-batch-001-rate-limited-writes',
    promptPath: '/repo/evals/operate-batch-001-rate-limited-writes/PROMPT.md',
    family: 'ops',
    stage: 'operate',
    runtime: 'live',
    limits: { time: 600 },
  },
];

const claude: AgentConfig = {
  id: 'claude-code-opus-5',
  label: 'Claude Code × Opus 5',
  harness: 'claude-code',
  model: 'opus',
  enabled: true,
};

const codex: AgentConfig = {
  id: 'codex-gpt-5.6-sol-high',
  label: 'Codex × GPT-5.6 Sol (high)',
  harness: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  enabled: true,
};

function options(patch: Partial<BuildPlanOptions> = {}): BuildPlanOptions {
  return {
    tasks,
    configs: [claude, codex],
    docsConditions: ['with', 'without'],
    trials: 3,
    concurrency: 2,
    maxAttempts: 3,
    defaultTimeoutSec: 900,
    cooldownMs: 30 * 60_000,
    evalsRoot: '/repo/evals',
    resultsRoot: '/repo/results',
    scoring: { enabled: true, timeoutMs: 600_000 },
    prompts: new Map(tasks.map((t) => [t.id, 'x'.repeat(100)])),
    verifiers: new Set(tasks.map((t) => t.id)),
    notionTokens: 1,
    templatesDir: '/opt/templates',
    env: { PATH: '/usr/bin' },
    ...patch,
  };
}

describe('buildPlan', () => {
  it('counts the full grid', () => {
    const plan = buildPlan(options());
    // 2 tasks × 2 configs × 2 docs × 3 trials
    expect(plan.totalCells).toBe(24);
    expect(plan.configs.map((c) => c.cells)).toEqual([12, 12]);
  });

  it('honours a config pinned to one docs condition', () => {
    const plan = buildPlan(
      options({ configs: [claude, { ...codex, docsCondition: 'without' }] }),
    );
    expect(plan.configs[1]!.docsConditions).toEqual(['without']);
    expect(plan.configs[1]!.cells).toBe(6);
    expect(plan.totalCells).toBe(18);
  });

  it('renders the exact argv per config with the prompt elided', () => {
    const plan = buildPlan(options());
    const args = plan.configs[0]!.args!;
    expect(plan.configs[0]!.command).toBe('claude');
    expect(args).toContain('{prompt}');
    expect(args).toContain('--output-format');
    // The real prompt never appears in the plan.
    expect(args.join(' ')).not.toContain('xxxx');
  });

  it('reports how the prompt reaches each CLI', () => {
    const plan = buildPlan(options());
    expect(plan.configs.map((c) => c.promptVia)).toEqual(['argv', 'argv']);
  });

  it('flags a config whose invocation cannot be built instead of failing late', () => {
    const broken: AgentConfig = {
      id: 'broken',
      label: 'Broken',
      harness: 'command-template',
      model: 'x',
      enabled: true,
      // no command / argsTemplate
    };
    const plan = buildPlan(options({ configs: [broken] }));
    expect(plan.configs[0]!.problem).toBeTruthy();
    expect(plan.warnings.join(' ')).toContain('broken');
  });

  it('uses the per-task timeout for the worst case, not the default', () => {
    const plan = buildPlan(options());
    // 12 cells per task: 900*12 + 600*12
    expect(plan.worstCaseAgentSeconds).toBe(900 * 12 + 600 * 12);
  });

  it('reports prompt sizes and which tasks have a verifier', () => {
    const plan = buildPlan(options({ verifiers: new Set(['build-nac-001-workspace-from-spec']) }));
    expect(plan.tasks[0]!.promptBytes).toBe(100);
    expect(plan.tasks[0]!.hasVerifier).toBe(true);
    expect(plan.tasks[1]!.hasVerifier).toBe(false);
    expect(plan.warnings.join(' ')).toContain('no verifier for operate-batch-001');
  });

  it('warns when live tasks are selected with no Notion token', () => {
    const plan = buildPlan(options({ notionTokens: 0 }));
    expect(plan.warnings.join(' ')).toMatch(/live task\(s\) selected but no NOTION_API_TOKEN/);
  });

  it('warns when scoring is disabled', () => {
    const plan = buildPlan(options({ scoring: { enabled: false, timeoutMs: 0 } }));
    expect(plan.warnings.join(' ')).toContain('--no-score');
  });

  it('lists the API-key vars that will be stripped from children', () => {
    const plan = buildPlan(
      options({ env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'sk-2' } }),
    );
    expect(plan.env.strippedPresent).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });

  it('never puts a secret value in the plan', () => {
    const plan = buildPlan(
      options({
        env: { ANTHROPIC_API_KEY: 'sk-secret-value' },
        configs: [{ ...claude, env: { MY_TOKEN: 'hunter2' } }],
      }),
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('hunter2');
    expect(plan.env.configEnvKeys).toEqual(['MY_TOKEN']);
  });

  it('reports the token pool as a count, never as values', () => {
    const plan = buildPlan(options({ notionTokens: 2 }));
    expect(plan.env.notionTokens).toBe(2);
  });
});

describe('renderPlan', () => {
  const text = renderPlan(buildPlan(options()));

  it('leads with the fact that nothing will be spawned', () => {
    expect(text.split('\n')[0]).toContain('DRY RUN');
    expect(text).toContain('no run directory will be created');
  });

  it('prints the grid, the tasks, the commands and the env', () => {
    expect(text).toContain('2 task(s) × 2 config(s) × with/without docs × 3 trial(s) = 24 cell(s)');
    expect(text).toContain('build-nac-001-workspace-from-spec');
    expect(text).toContain("$ claude -p '{prompt}'");
    expect(text).toContain('NOTION_KEYRING');
    expect(text).toContain('templates');
  });

  it('shell-quotes for display only, keeping the prompt one argument', () => {
    expect(text).toContain("-c 'model_reasoning_effort=\"high\"'");
  });

  it('tells the operator how to run it for real', () => {
    expect(text.trimEnd().endsWith('run it: drop --dry-run.')).toBe(true);
  });
});
