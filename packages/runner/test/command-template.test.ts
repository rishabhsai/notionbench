import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import {
  CommandTemplateError,
  commandTemplateAdapter,
  normalizeLooseUsage,
} from '../src/parsers/command-template.js';
import { getAdapter } from '../src/parsers/index.js';
import { clearVersionCache, runTrial, type TrialIdentity } from '../src/spawn.js';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-tmpl-'));
  clearVersionCache();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const base: AgentConfig = {
  id: 'opencode-sonnet',
  label: 'OpenCode × Sonnet',
  harness: 'command-template',
  model: 'anthropic/claude-sonnet-5',
  enabled: true,
  command: 'opencode',
  argsTemplate: ['run', '--model', '{model}', '--cwd', '{workspace}', '{prompt}'],
};

describe('command-template invocation', () => {
  it('is registered so any prompt-in/files-out CLI can be benchmarked', () => {
    expect(getAdapter('command-template').id).toBe('command-template');
  });

  it('substitutes every placeholder', () => {
    const inv = commandTemplateAdapter.buildInvocation(
      { ...base, reasoningEffort: 'high', argsTemplate: [...base.argsTemplate!, '--effort={effort}', '{configId}'] },
      { prompt: 'Do the task', workspaceDir: '/tmp/ws' },
    );
    expect(inv.command).toBe('opencode');
    expect(inv.args).toEqual([
      'run',
      '--model',
      'anthropic/claude-sonnet-5',
      '--cwd',
      '/tmp/ws',
      'Do the task',
      '--effort=high',
      'opencode-sonnet',
    ]);
    expect(inv.stdin).toBe('ignore');
  });

  it('keeps the prompt as a single argv element even when it contains shell syntax', () => {
    const nasty = '`rm -rf /`; $(id) && echo "pwned"';
    const inv = commandTemplateAdapter.buildInvocation(base, {
      prompt: nasty,
      workspaceDir: '/tmp/ws',
    });
    expect(inv.args).toContain(nasty);
  });

  it('routes the prompt through stdin when promptVia is set', () => {
    const inv = commandTemplateAdapter.buildInvocation(
      { ...base, promptVia: 'stdin', argsTemplate: ['run', '--cwd', '{workspace}'] },
      { prompt: 'On stdin please', workspaceDir: '/tmp/ws' },
    );
    expect(inv.stdin).toEqual({ write: 'On stdin please' });
    expect(inv.args).toEqual(['run', '--cwd', '/tmp/ws']);
  });

  it('refuses a template that would never deliver the prompt', () => {
    expect(() =>
      commandTemplateAdapter.buildInvocation(
        { ...base, argsTemplate: ['run', '--cwd', '{workspace}'] },
        { prompt: 'p', workspaceDir: '/w' },
      ),
    ).toThrow(CommandTemplateError);
  });

  it('refuses a config with no command', () => {
    expect(() =>
      commandTemplateAdapter.buildInvocation(
        { ...base, command: undefined },
        { prompt: 'p', workspaceDir: '/w' },
      ),
    ).toThrow(/sets no "command"/);
  });
});

describe('command-template usage heuristics', () => {
  it('finds a nested usage object under an unknown envelope', () => {
    const parsed = commandTemplateAdapter.parse({
      stdoutLines: [
        '{"event":"start"}',
        '{"event":"finish","meta":{"tokens":{"prompt_tokens":1200,"completion_tokens":340}}}',
      ],
      stderrLines: [],
    });
    expect(parsed.usage).toMatchObject({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540 });
    expect(parsed.usageRaw).toMatchObject({ source: 'command-template heuristic' });
  });

  it('picks the largest report when several are emitted', () => {
    const parsed = commandTemplateAdapter.parse({
      stdoutLines: [
        '{"usage":{"input_tokens":10,"output_tokens":5}}',
        '{"usage":{"input_tokens":900,"output_tokens":120}}',
        '{"usage":{"input_tokens":100,"output_tokens":10}}',
      ],
      stderrLines: [],
    });
    expect(parsed.usage?.inputTokens).toBe(900);
    expect(parsed.parseWarnings.join(' ')).toContain('dedicated adapter');
  });

  it('reports no usage rather than fabricating zeros when the CLI is silent', () => {
    const quiet = commandTemplateAdapter.parse({
      stdoutLines: ['Working…', 'Done.'],
      stderrLines: [],
    });
    expect(quiet.usage).toBeNull();
    expect(quiet.parseWarnings.join(' ')).toContain('no JSON lines');

    const jsonNoUsage = commandTemplateAdapter.parse({
      stdoutLines: ['{"status":"ok"}'],
      stderrLines: [],
    });
    expect(jsonNoUsage.usage).toBeNull();
    expect(jsonNoUsage.parseWarnings.join(' ')).toContain('recognizable token-usage');
  });

  it('does not double-count cached input it believes is already included', () => {
    const usage = normalizeLooseUsage({ input_tokens: 1000, cached_tokens: 800, output_tokens: 50 });
    expect(usage).toMatchObject({
      inputTokensIncludeCached: true,
      totalTokens: 1050,
    });
  });

  it('adds cache reads to the total when the input count is clearly exclusive', () => {
    const usage = normalizeLooseUsage({
      input_tokens: 10,
      cache_read_input_tokens: 5000,
      output_tokens: 50,
    });
    expect(usage).toMatchObject({ inputTokensIncludeCached: false, totalTokens: 5060 });
  });
});

describe('command-template end to end', () => {
  const IDENTITY: TrialIdentity = {
    runId: 'r',
    taskId: 't',
    configId: 'custom',
    docsCondition: 'with',
    trial: 1,
  };

  async function fakeCli(body: string): Promise<string> {
    const p = path.join(scratch, 'fake-agent');
    await writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  it('runs an arbitrary CLI and captures its files-out result', async () => {
    const cli = await fakeCli(`
if [ "$1" = "--version" ]; then echo "fake-agent 9.9.9"; exit 0; fi
echo "prompt=$3" > "$2/agent-saw.txt"
echo '{"usage":{"input_tokens":700,"output_tokens":42}}'
`);
    const workspaceDir = path.join(scratch, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceDir, { recursive: true });

    const outcome = await runTrial({
      config: {
        id: 'custom',
        label: 'custom',
        harness: 'command-template',
        model: 'm',
        enabled: true,
        command: cli,
        argsTemplate: ['run', '{workspace}', '{prompt}'],
      },
      identity: IDENTITY,
      prompt: 'write a file',
      workspaceDir,
      trialDir: path.join(scratch, 'results'),
      timeoutMs: 10_000,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.usage?.totalTokens).toBe(742);
    expect(outcome.invocation.cliVersion).toBe('fake-agent 9.9.9');
    // files-out: the workspace is what the verifier will grade.
    expect(await readFile(path.join(workspaceDir, 'agent-saw.txt'), 'utf8')).toContain(
      'prompt=write a file',
    );
  });

  it('delivers the prompt on stdin and closes the pipe', async () => {
    const cli = await fakeCli(`
if [ "$1" = "--version" ]; then echo "v1"; exit 0; fi
# Blocks forever if the runner leaves stdin open.
cat > "$1/from-stdin.txt"
echo '{"input_tokens":5,"output_tokens":1}'
`);
    const workspaceDir = path.join(scratch, 'ws2');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceDir, { recursive: true });

    const outcome = await runTrial({
      config: {
        id: 'custom',
        label: 'custom',
        harness: 'command-template',
        model: 'm',
        enabled: true,
        command: cli,
        argsTemplate: ['{workspace}'],
        promptVia: 'stdin',
      },
      identity: IDENTITY,
      prompt: 'prompt via stdin',
      workspaceDir,
      trialDir: path.join(scratch, 'results2'),
      timeoutMs: 10_000,
    });

    expect(outcome.status).toBe('completed');
    expect(await readFile(path.join(workspaceDir, 'from-stdin.txt'), 'utf8')).toBe(
      'prompt via stdin',
    );
  });
});
