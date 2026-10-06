import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator, formatError, isReviewError, ErrorCodes } from './utils/index.js';

// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // --- Validate command line arguments ---
  if (!owner || !repo || !prStr) {
    console.error('Error: Missing required arguments.\n');
    console.error('Usage: npm run dev <owner> <repo> <pr-number>');
    console.error('Example: npm run dev udacity cd14715-simple-todo-app 1');
    process.exit(1);
  }

  const prNumber = Number.parseInt(prStr, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || String(prNumber) !== prStr.trim()) {
    console.error(`Error: Invalid pull request number "${prStr}". Must be a positive integer.`);
    process.exit(1);
  }

  // --- Validate authentication (choose ONE method) ---
  const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasBedrockCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );

  if (hasBedrockCredentials) {
    if (!process.env.AWS_REGION) {
      console.error(
        'Error: AWS Bedrock credentials are set (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) ' +
          'but AWS_REGION is missing. Set AWS_REGION in your environment or .env file.'
      );
      process.exit(1);
    }
    console.log('🔐 Using AWS Bedrock authentication');
  } else if (hasAnthropicApiKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    console.error('Error: No valid authentication method configured.\n');
    console.error('Configure ONE of the following:');
    console.error('  1. Anthropic API:   set ANTHROPIC_API_KEY in your environment or .env file');
    console.error(
      '  2. AWS Bedrock:     set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION'
    );
    process.exit(1);
  }

  // --- Validate ANTHROPIC_MODEL ---
  if (!process.env.ANTHROPIC_MODEL) {
    console.error('Error: ANTHROPIC_MODEL environment variable is required.\n');
    console.error('Set it in your .env file, for example:');
    console.error('  For Anthropic API:  ANTHROPIC_MODEL=claude-sonnet-4-5-20250929');
    console.error('  For AWS Bedrock:    ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    process.exit(1);
  }

  console.log(`\n🔍 Reviewing pull request ${owner}/${repo}#${prNumber}...\n`);

  try {
    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    const reportGenerator = new ReportGenerator();
    const reportsDir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const baseName = `${owner}_${repo}_${prNumber}`;
    const outputs: Array<[string, string]> = [
      [`${baseName}.json`, reportGenerator.generateJSONReport(report)],
      [`${baseName}.md`, reportGenerator.generateMarkdownReport(report)],
      [`${baseName}.html`, reportGenerator.generateHTMLReport(report)]
    ];

    for (const [filename, content] of outputs) {
      const filePath = path.join(reportsDir, filename);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ Wrote ${path.relative(process.cwd(), filePath)}`);
    }

    console.log(
      `\n✨ Review complete. Overall score: ${report.summary.overallScore}/100, ` +
        `${report.summary.totalFiles} file(s) analyzed, ` +
        `${report.summary.criticalIssues} critical issue(s) found.`
    );
  } catch (error) {
    if (isReviewError(error)) {
      switch (error.code) {
        case ErrorCodes.PR_NOT_FOUND:
          console.error(`\n❌ Pull request ${owner}/${repo}#${prNumber} was not found.`);
          break;
        case ErrorCodes.RATE_LIMITED:
          console.error(
            '\n❌ Hit a GitHub or Anthropic API rate limit. ' +
              'Consider setting GITHUB_TOKEN in your .env file and retrying.'
          );
          break;
        case ErrorCodes.AGENT_TIMEOUT:
          console.error('\n❌ The review timed out before completing. Try again or reduce scope.');
          break;
        case ErrorCodes.VALIDATION_FAILED:
          console.error(
            '\n❌ The agent produced output that did not match the expected report schema.'
          );
          break;
        default:
          console.error(`\n❌ Review failed: ${formatError(error)}`);
      }
      if (error.metadata) {
        console.error('Details:', JSON.stringify(error.metadata, null, 2));
      }
    } else {
      console.error('\n❌ Unexpected error:', formatError(error));
    }
    process.exit(1);
  }
}

main();
