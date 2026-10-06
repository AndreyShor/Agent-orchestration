import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * Model Context Protocol (MCP) server configurations
 *
 * Required MCP Servers:
 * 1. GitHub - For PR/repo operations
 * 2. ESLint - For code linting and style analysis
 *
 * Documentation:
 * - MCP Protocol: https://modelcontextprotocol.io
 * - GitHub MCP: https://github.com/github/github-mcp-server
 * - ESLint MCP: https://eslint.org/docs/latest/use/mcp
 */

export const mcpServersConfig: Record<string, McpServerConfig> = {
  /**
   * GitHub MCP Server
   * Provides tools for GitHub API operations (fetching PR metadata,
   * changed files, diffs, review comments, etc.)
   *
   * Note: GITHUB_TOKEN is optional (recommended for private repos and higher
   * rate limits). The GitHub MCP server expects GITHUB_PERSONAL_ACCESS_TOKEN
   * as its env var name, so we remap our GITHUB_TOKEN from .env to the name
   * the server actually looks for.
   */
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }
  },

  /**
   * ESLint MCP Server
   * Provides tools for linting and code quality analysis.
   * No authentication required.
   */
  eslint: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@eslint/mcp@latest'],
    env: {}
  }
};
