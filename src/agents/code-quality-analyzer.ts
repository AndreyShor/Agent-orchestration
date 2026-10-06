import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';

/**
 * Code Quality Analyzer subagent.
 *
 * Analyzes a single file for security vulnerabilities, performance issues,
 * and maintainability/best-practice concerns. Leverages the
 * `security-analysis`, `typescript-patterns`, `javascript-best-practices`,
 * and `performance-optimization` Claude Skills, plus the ESLint MCP server
 * for automated lint findings.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Use this agent to review a single changed file for security vulnerabilities, ' +
    'performance problems, and maintainability/best-practice issues. Dispatch it for ' +
    'every reviewable file in a pull request, alongside (not instead of) the ' +
    'test-coverage-analyzer and refactoring-suggester agents.',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__eslint'],
  model: 'inherit'
};
