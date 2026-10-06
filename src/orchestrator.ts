import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import { ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import type { ReviewReport } from './types/report-types.js';
import { mcpServersConfig } from './config/mcp.config.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import {
  logReviewStart,
  logReviewComplete,
  logReviewError,
  logAgentStart,
  logAgentComplete,
  logger
} from './utils/logger.js';
import {
  RateLimiter,
  type RateLimiterConfig,
  withRateLimit,
  withRetry,
  withTimeout,
  ReviewError,
  ErrorCodes,
  formatError
} from './utils/index.js';

/** Known agent names, used for both `options.agents` keys and `agentVersions` metadata. */
const AGENT_VERSIONS: Record<string, string> = {
  'code-quality-analyzer': '1.0.0',
  'test-coverage-analyzer': '1.0.0',
  'refactoring-suggester': '1.0.0'
};

/** Estimated tokens consumed by one full orchestrated review (orchestrator + 3 subagents x N files). */
const ESTIMATED_TOKENS_PER_REVIEW = 60000;

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Model to use for the orchestrator and (via model: 'inherit') its subagents. */
  model?: string;
  /** Maximum number of agent turns allowed for a single review. */
  maxTurns?: number;
  /** Maximum wall-clock time (ms) allowed for a single review before aborting. */
  timeoutMs?: number;
  /** Maximum number of whole-review attempts (including the first) on transient failure. */
  maxRetries?: number;
  /** Rate limit overrides for the orchestrator's own RateLimiter instance. */
  rateLimits?: Partial<RateLimiterConfig>;
  /** Working directory the SDK runs in; must contain `.claude/skills/`. Defaults to PROJECT_ROOT. */
  cwd?: string;
}

const DEFAULT_MAX_TURNS = 80;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_RETRIES = 2;

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private readonly model: string | undefined;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cwd: string;
  private readonly rateLimiter: RateLimiter;

  constructor(options: OrchestratorOptions = {}) {
    this.model = options.model ?? process.env.ANTHROPIC_MODEL;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.cwd = options.cwd ?? process.env.PROJECT_ROOT ?? process.cwd();
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();
    logReviewStart(owner, repo, prNumber);

    try {
      const resultMessage = await withTimeout(
        () =>
          withRetry(
            () =>
              withRateLimit(
                this.rateLimiter,
                () => this.runQuery(owner, repo, prNumber),
                ESTIMATED_TOKENS_PER_REVIEW
              ),
            this.maxRetries,
            2000
          ),
        this.timeoutMs,
        `Review of ${owner}/${repo}#${prNumber} timed out after ${this.timeoutMs}ms`
      );

      // runQuery() already throws for any non-'success' subtype, so this
      // narrowing is guaranteed to hold at runtime even though it crosses
      // an async function boundary TypeScript can't see through.
      const successMessage = resultMessage as Extract<SDKResultMessage, { subtype: 'success' }>;
      const report = this.buildReport(successMessage, owner, repo, prNumber, startTime);

      logReviewComplete(owner, repo, prNumber, report.summary.overallScore, report.metadata.duration);
      return report;
    } catch (error) {
      const errorForLog = error instanceof Error ? error : new Error(formatError(error));
      logReviewError(owner, repo, prNumber, errorForLog);
      throw error;
    }
  }

  /**
   * Run a single query() attempt against the Claude Agent SDK and return its
   * terminal result message. Does not itself handle retries/timeouts/rate
   * limiting — those are composed by reviewPullRequest().
   */
  private async runQuery(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<SDKResultMessage> {
    const prompt = buildOrchestratorPrompt(owner, repo, prNumber);

    const options: Options = {
      model: this.model,
      cwd: this.cwd,
      maxTurns: this.maxTurns,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      mcpServers: mcpServersConfig,
      agents: {
        'code-quality-analyzer': codeQualityAnalyzer,
        'test-coverage-analyzer': testCoverageAnalyzer,
        'refactoring-suggester': refactoringSuggester
      },
      allowedTools: [
        'Task',
        'Read',
        'Grep',
        'Glob',
        'Skill',
        'mcp__github',
        'mcp__eslint'
      ],
      outputFormat: {
        type: 'json_schema',
        schema: ReviewReportJSONSchema
      }
    };

    let resultMessage: SDKResultMessage | undefined;

    for await (const message of query({ prompt, options })) {
      this.handleStreamMessage(message);
      if (message.type === 'result') {
        resultMessage = message;
      }
    }

    if (!resultMessage) {
      throw new ReviewError(
        'Agent query stream ended without producing a result message',
        ErrorCodes.AGENT_FAILED
      );
    }

    if (resultMessage.subtype !== 'success') {
      throw new ReviewError(
        `Agent query did not complete successfully (${resultMessage.subtype})`,
        resultMessage.subtype === 'error_max_turns'
          ? ErrorCodes.AGENT_FAILED
          : ErrorCodes.AGENT_FAILED,
        { subtype: resultMessage.subtype }
      );
    }

    return resultMessage;
  }

  /**
   * Best-effort observability hook: logs subagent dispatch (Task tool calls)
   * as they stream past. Never throws — a logging failure must not break
   * the review.
   */
  private handleStreamMessage(message: SDKMessage): void {
    try {
      if (message.type === 'assistant') {
        const content = (message.message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'tool_use' &&
            (block as { name?: string }).name === 'Task'
          ) {
            const input = (block as { input?: Record<string, unknown> }).input ?? {};
            const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'unknown-agent';
            const description = typeof input.description === 'string' ? input.description : '';
            logAgentStart(subagentType, description);
          }
        }
      } else if (message.type === 'result') {
        logger.debug('Orchestrator query result received', {
          subtype: message.subtype,
          numTurns: message.num_turns,
          durationMs: message.duration_ms
        });
      }
    } catch (err) {
      logger.debug('Non-fatal error while logging stream message', { error: formatError(err) });
    }
  }

  /**
   * Extract and validate the structured ReviewReport from a successful
   * result message, then fill in metadata and recompute the summary
   * defensively from the aggregated file reviews.
   */
  private buildReport(
    resultMessage: Extract<SDKResultMessage, { subtype: 'success' }>,
    owner: string,
    repo: string,
    prNumber: number,
    startTime: number
  ): ReviewReport {
    const raw = this.extractStructuredOutput(resultMessage);

    const parsed = ReviewReportSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReviewError(
        'Orchestrator output did not match the ReviewReport schema',
        ErrorCodes.VALIDATION_FAILED,
        { issues: parsed.error.issues }
      );
    }

    const report = parsed.data;
    const duration = Date.now() - startTime;

    const summary = this.recomputeSummary(report.fileReviews);

    return {
      ...report,
      pullRequest: { owner, repo, number: prNumber },
      summary,
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: { ...AGENT_VERSIONS, ...report.metadata?.agentVersions }
      }
    };
  }

  /**
   * Pull the structured output out of a result message. Falls back to
   * parsing JSON out of the free-text `result` field (tolerating a
   * surrounding markdown code fence) if `structured_output` is absent.
   */
  private extractStructuredOutput(resultMessage: Extract<SDKResultMessage, { subtype: 'success' }>): unknown {
    if (resultMessage.structured_output !== undefined) {
      return resultMessage.structured_output;
    }

    const text = resultMessage.result?.trim() ?? '';
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch ? fencedMatch[1] : text;

    try {
      return JSON.parse(candidate ?? '');
    } catch (err) {
      throw new ReviewError(
        'Could not parse structured output from agent result text',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { resultText: text, parseError: formatError(err) }
      );
    }
  }

  /**
   * Recompute the summary from the aggregated file reviews rather than
   * trusting the model's own arithmetic.
   */
  private recomputeSummary(fileReviews: ReviewReport['fileReviews']): ReviewReport['summary'] {
    const totalFiles = fileReviews.length;

    const criticalIssues = fileReviews.reduce(
      (sum, fr) => sum + fr.codeQuality.issues.filter((i) => i.severity === 'critical').length,
      0
    );

    const highPriorityTests = fileReviews.reduce(
      (sum, fr) =>
        sum +
        fr.testCoverage.untestedPaths.filter((p) => p.priority === 'critical' || p.priority === 'high').length,
      0
    );

    const refactoringOpportunities = fileReviews.reduce(
      (sum, fr) => sum + fr.refactorings.suggestions.length,
      0
    );

    const overallScore =
      totalFiles === 0
        ? 0
        : Math.round(
            fileReviews.reduce((sum, fr) => sum + fr.codeQuality.overallScore, 0) / totalFiles
          );

    return {
      totalFiles,
      overallScore,
      criticalIssues,
      highPriorityTests,
      refactoringOpportunities
    };
  }
}
