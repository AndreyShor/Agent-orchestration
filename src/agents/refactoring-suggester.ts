import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

/**
 * Refactoring Suggester subagent.
 *
 * Identifies structural improvements for a single changed file: design
 * pattern opportunities, modernization, extract-function/class candidates,
 * simplification, and dead code. Leverages the `typescript-patterns` /
 * `javascript-best-practices` Claude Skills to ground suggestions in
 * current language idioms.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Use this agent to identify structural/refactoring opportunities in a single ' +
    'changed file: design patterns, modernization, extract-method candidates, ' +
    'simplification, and dead code. Dispatch it for every reviewable file in a pull ' +
    'request, alongside (not instead of) the code-quality-analyzer and ' +
    'test-coverage-analyzer agents.',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  model: 'inherit'
};
