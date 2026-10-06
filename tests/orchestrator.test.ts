import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for CodeReviewOrchestrator
 *
 * The Claude Agent SDK's `query()` is mocked so these tests run without any
 * network access or API credentials. The mock returns an async generator
 * that yields a single SDKResultMessage, mirroring what the real SDK
 * streams back after an orchestrated multi-agent review completes.
 */

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock
}));

// Import AFTER the mock is registered.
const { CodeReviewOrchestrator } = await import('../src/orchestrator.js');
const { ReviewReportSchema } = await import('../src/types/report-types.js');

function makeFileReview(file: string) {
  return {
    file,
    codeQuality: {
      file,
      issues: [
        {
          line: 10,
          severity: 'critical' as const,
          category: 'security' as const,
          description: 'Hardcoded API key.',
          suggestion: 'Move to environment variable.'
        }
      ],
      overallScore: 60,
      summary: 'One critical security issue found.'
    },
    testCoverage: {
      file,
      hasTests: false,
      testFiles: [],
      untestedPaths: [
        {
          type: 'function' as const,
          location: 'doWork()',
          priority: 'high' as const,
          reasoning: 'No tests exist for this file.',
          suggestedTest: "it('does work', () => { expect(doWork()).toBe(true); });"
        }
      ],
      coverageEstimate: 0,
      summary: 'No tests exist for this file.'
    },
    refactorings: {
      file,
      suggestions: [
        {
          type: 'simplify' as const,
          location: 'doWork()',
          impact: 'low' as const,
          description: 'Redundant intermediate variable.',
          before: 'const x = y; return x;',
          after: 'return y;',
          benefits: 'Removes unnecessary indirection.'
        }
      ],
      summary: 'One minor simplification available.'
    }
  };
}

function makeValidReviewReport() {
  return {
    pullRequest: { owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 1 },
    fileReviews: [makeFileReview('src/app.ts')],
    summary: {
      totalFiles: 1,
      overallScore: 60,
      criticalIssues: 1,
      highPriorityTests: 1,
      refactoringOpportunities: 1
    },
    recommendations: [
      {
        priority: 'critical' as const,
        category: 'security',
        description: 'Remove hardcoded API key from src/app.ts',
        files: ['src/app.ts']
      }
    ],
    metadata: {
      analyzedAt: new Date().toISOString(),
      duration: 1000,
      agentVersions: { 'code-quality-analyzer': '1.0.0' }
    }
  };
}

function makeSuccessResultMessage(structuredOutput: unknown) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 5,
    result: JSON.stringify(structuredOutput),
    total_cost_usd: 0.05,
    usage: {},
    structured_output: structuredOutput,
    uuid: 'test-uuid',
    session_id: 'test-session'
  };
}

/** Wraps a single message in an async generator, mimicking the SDK's Query type. */
async function* singleMessageStream(message: unknown) {
  yield message;
}

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
  });

  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });

    it('should accept custom rate limit configuration', () => {
      const orchestrator = new CodeReviewOrchestrator({
        rateLimits: { maxConcurrent: 1, maxRequestsPerMinute: 5, maxTokensPerMinute: 1000 }
      });
      // The custom limiter is private, but construction should not throw and
      // the instance should behave normally end-to-end (exercised in the
      // reviewPullRequest tests below).
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });
  });

  describe('reviewPullRequest', () => {
    it('passes PR identifiers into the orchestrator prompt and configures Task/MCP tools', async () => {
      const report = makeValidReviewReport();
      queryMock.mockReturnValue(singleMessageStream(makeSuccessResultMessage(report)));

      const orchestrator = new CodeReviewOrchestrator();
      await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const callArgs = queryMock.mock.calls[0][0];

      expect(callArgs.prompt).toContain('udacity');
      expect(callArgs.prompt).toContain('cd14715-simple-todo-app');
      expect(callArgs.prompt).toContain('1');

      expect(callArgs.options.allowedTools).toContain('Task');
      expect(callArgs.options.allowedTools).toContain('Skill');
      expect(Object.keys(callArgs.options.mcpServers)).toEqual(
        expect.arrayContaining(['github', 'eslint'])
      );
    });

    it('registers all three subagents for the orchestrator to dispatch', async () => {
      const report = makeValidReviewReport();
      queryMock.mockReturnValue(singleMessageStream(makeSuccessResultMessage(report)));

      const orchestrator = new CodeReviewOrchestrator();
      await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1);

      const callArgs = queryMock.mock.calls[0][0];
      expect(Object.keys(callArgs.options.agents)).toEqual(
        expect.arrayContaining([
          'code-quality-analyzer',
          'test-coverage-analyzer',
          'refactoring-suggester'
        ])
      );
      for (const agent of Object.values(callArgs.options.agents) as Array<{ model?: string }>) {
        expect(agent.model).toBe('inherit');
      }
    });

    it('aggregates the structured output into a ReviewReport with recomputed summary', async () => {
      const report = makeValidReviewReport();
      queryMock.mockReturnValue(singleMessageStream(makeSuccessResultMessage(report)));

      const orchestrator = new CodeReviewOrchestrator();
      const result = await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1);

      expect(result.pullRequest).toEqual({ owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 1 });
      expect(result.fileReviews).toHaveLength(1);
      // Recomputed defensively from fileReviews, not trusted from the model:
      expect(result.summary.criticalIssues).toBe(1);
      expect(result.summary.highPriorityTests).toBe(1);
      expect(result.summary.refactoringOpportunities).toBe(1);
      expect(result.summary.overallScore).toBe(60);
      expect(result.metadata.analyzedAt).toBeTruthy();
      expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('validates the final output with the ReviewReport Zod schema', async () => {
      const report = makeValidReviewReport();
      queryMock.mockReturnValue(singleMessageStream(makeSuccessResultMessage(report)));

      const orchestrator = new CodeReviewOrchestrator();
      const result = await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1);

      expect(ReviewReportSchema.safeParse(result).success).toBe(true);
    });

    it('throws a ReviewError when the agent output fails schema validation', async () => {
      const malformedReport = { not: 'a valid review report' };
      queryMock.mockReturnValue(singleMessageStream(makeSuccessResultMessage(malformedReport)));

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });

      await expect(
        orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1)
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('throws a ReviewError when the query stream never yields a result message', async () => {
      queryMock.mockReturnValue(singleMessageStream({ type: 'assistant', message: { content: [] } }));

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });

      // withRetry wraps the underlying AGENT_FAILED error as RETRY_EXHAUSTED
      // once all attempts (here, just 1) are used up.
      await expect(
        orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 1)
      ).rejects.toMatchObject({
        code: 'RETRY_EXHAUSTED',
        message: expect.stringContaining('AGENT_FAILED')
      });
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      // NOTE: Only run manually with valid ANTHROPIC_API_KEY / GITHUB_TOKEN.
      const orchestrator = new CodeReviewOrchestrator();
      const report = await orchestrator.reviewPullRequest(
        'udacity',
        'cd14715-simple-todo-app',
        1
      );
      expect(ReviewReportSchema.safeParse(report).success).toBe(true);
    });
  });
});
