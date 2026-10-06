import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

/**
 * Test Coverage Analyzer subagent.
 *
 * Determines whether a changed file has corresponding tests, identifies
 * untested functions/branches/edge cases, and proposes specific, runnable
 * test cases with real assertions. Uses Read/Grep/Glob to locate and
 * inspect sibling test files.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Use this agent to assess test completeness for a single changed file: whether ' +
    'tests exist, which functions/branches/edge cases are untested, and what specific ' +
    'test cases would close the gaps. Dispatch it for every reviewable file in a pull ' +
    'request, alongside (not instead of) the code-quality-analyzer and ' +
    'refactoring-suggester agents.',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  model: 'inherit'
};
