import { describe, it, expect } from 'vitest';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema,
  CodeQualityResultJSONSchema,
  TestCoverageResultJSONSchema,
  RefactoringSuggestionJSONSchema,
  ReviewReportSchema,
  ReviewReportJSONSchema
} from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCodeQuality = {
  file: 'src/example.ts',
  issues: [
    {
      line: 42,
      severity: 'high' as const,
      category: 'security' as const,
      description: 'User input reaches a SQL query without parameterization.',
      suggestion: 'Use a parameterized query via the query builder.'
    }
  ],
  overallScore: 76,
  summary: 'One high-severity SQL injection risk found; otherwise clean.'
};

const validTestCoverage = {
  file: 'src/example.ts',
  hasTests: true,
  testFiles: ['src/example.test.ts'],
  untestedPaths: [
    {
      type: 'branch' as const,
      location: 'else-branch at line 58',
      priority: 'medium' as const,
      reasoning: 'Error path is never exercised by existing tests.',
      suggestedTest: "it('throws on invalid input', () => { expect(() => fn(null)).toThrow(); });"
    }
  ],
  coverageEstimate: 65,
  summary: '65% of testable paths covered; one medium-priority gap.'
};

const validRefactoring = {
  file: 'src/example.ts',
  suggestions: [
    {
      type: 'extract-function' as const,
      location: 'processOrder()',
      impact: 'medium' as const,
      description: 'processOrder() mixes validation and persistence.',
      before: 'function processOrder(o) { /* validation */ /* save */ }',
      after: 'function processOrder(o) { validate(o); save(o); }',
      benefits: 'Separates concerns, easier to test independently.'
    }
  ],
  summary: 'One extract-function opportunity; otherwise well structured.'
};

const validReviewReport = {
  pullRequest: { owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 1 },
  fileReviews: [
    {
      file: 'src/example.ts',
      codeQuality: validCodeQuality,
      testCoverage: validTestCoverage,
      refactorings: validRefactoring
    }
  ],
  summary: {
    totalFiles: 1,
    overallScore: 76,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 1
  },
  recommendations: [
    {
      priority: 'high' as const,
      category: 'security',
      description: 'Fix SQL injection risk in src/example.ts',
      files: ['src/example.ts']
    }
  ],
  metadata: {
    analyzedAt: new Date().toISOString(),
    duration: 12345,
    agentVersions: { 'code-quality-analyzer': '1.0.0' }
  }
};

// ---------------------------------------------------------------------------
// CodeQualityResultSchema
// ---------------------------------------------------------------------------

describe('CodeQualityResultSchema', () => {
  it('accepts a valid result', () => {
    expect(CodeQualityResultSchema.safeParse(validCodeQuality).success).toBe(true);
  });

  it('accepts an empty issues array with overallScore 100', () => {
    const result = CodeQualityResultSchema.safeParse({
      ...validCodeQuality,
      issues: [],
      overallScore: 100
    });
    expect(result.success).toBe(true);
  });

  it('accepts boundary scores 0 and 100', () => {
    expect(
      CodeQualityResultSchema.safeParse({ ...validCodeQuality, overallScore: 0 }).success
    ).toBe(true);
    expect(
      CodeQualityResultSchema.safeParse({ ...validCodeQuality, overallScore: 100 }).success
    ).toBe(true);
  });

  it('rejects overallScore below 0', () => {
    const result = CodeQualityResultSchema.safeParse({ ...validCodeQuality, overallScore: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects overallScore above 100', () => {
    const result = CodeQualityResultSchema.safeParse({ ...validCodeQuality, overallScore: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid severity enum value', () => {
    const result = CodeQualityResultSchema.safeParse({
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], severity: 'catastrophic' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid category enum value', () => {
    const result = CodeQualityResultSchema.safeParse({
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], category: 'ux' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { summary, ...withoutSummary } = validCodeQuality;
    expect(CodeQualityResultSchema.safeParse(withoutSummary).success).toBe(false);
  });

  it('rejects wrong types', () => {
    const result = CodeQualityResultSchema.safeParse({ ...validCodeQuality, overallScore: '76' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestCoverageResultSchema
// ---------------------------------------------------------------------------

describe('TestCoverageResultSchema', () => {
  it('accepts a valid result', () => {
    expect(TestCoverageResultSchema.safeParse(validTestCoverage).success).toBe(true);
  });

  it('accepts hasTests: false with empty testFiles and untestedPaths', () => {
    const result = TestCoverageResultSchema.safeParse({
      ...validTestCoverage,
      hasTests: false,
      testFiles: [],
      untestedPaths: [],
      coverageEstimate: 0
    });
    expect(result.success).toBe(true);
  });

  it('accepts boundary coverageEstimate 0 and 100', () => {
    expect(
      TestCoverageResultSchema.safeParse({ ...validTestCoverage, coverageEstimate: 0 }).success
    ).toBe(true);
    expect(
      TestCoverageResultSchema.safeParse({ ...validTestCoverage, coverageEstimate: 100 }).success
    ).toBe(true);
  });

  it('rejects coverageEstimate out of range', () => {
    expect(
      TestCoverageResultSchema.safeParse({ ...validTestCoverage, coverageEstimate: -5 }).success
    ).toBe(false);
    expect(
      TestCoverageResultSchema.safeParse({ ...validTestCoverage, coverageEstimate: 150 }).success
    ).toBe(false);
  });

  it('rejects an invalid type enum value on an untested path', () => {
    const result = TestCoverageResultSchema.safeParse({
      ...validTestCoverage,
      untestedPaths: [{ ...validTestCoverage.untestedPaths[0], type: 'module' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid priority enum value', () => {
    const result = TestCoverageResultSchema.safeParse({
      ...validTestCoverage,
      untestedPaths: [{ ...validTestCoverage.untestedPaths[0], priority: 'urgent' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { hasTests, ...withoutHasTests } = validTestCoverage;
    expect(TestCoverageResultSchema.safeParse(withoutHasTests).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RefactoringSuggestionSchema
// ---------------------------------------------------------------------------

describe('RefactoringSuggestionSchema', () => {
  it('accepts a valid result', () => {
    expect(RefactoringSuggestionSchema.safeParse(validRefactoring).success).toBe(true);
  });

  it('accepts an empty suggestions array', () => {
    expect(
      RefactoringSuggestionSchema.safeParse({ ...validRefactoring, suggestions: [] }).success
    ).toBe(true);
  });

  it('rejects an invalid type enum value', () => {
    const result = RefactoringSuggestionSchema.safeParse({
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], type: 'rewrite-everything' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid impact enum value', () => {
    const result = RefactoringSuggestionSchema.safeParse({
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], impact: 'extreme' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field on a suggestion', () => {
    const { before, ...suggestionWithoutBefore } = validRefactoring.suggestions[0];
    const result = RefactoringSuggestionSchema.safeParse({
      ...validRefactoring,
      suggestions: [suggestionWithoutBefore]
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReviewReportSchema
// ---------------------------------------------------------------------------

describe('ReviewReportSchema', () => {
  it('accepts a valid report', () => {
    expect(ReviewReportSchema.safeParse(validReviewReport).success).toBe(true);
  });

  it('accepts an empty fileReviews array', () => {
    const result = ReviewReportSchema.safeParse({
      ...validReviewReport,
      fileReviews: [],
      summary: { ...validReviewReport.summary, totalFiles: 0 },
      recommendations: []
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid recommendation priority', () => {
    const result = ReviewReportSchema.safeParse({
      ...validReviewReport,
      recommendations: [{ ...validReviewReport.recommendations[0], priority: 'urgent' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric pull request number', () => {
    const result = ReviewReportSchema.safeParse({
      ...validReviewReport,
      pullRequest: { ...validReviewReport.pullRequest, number: '1' }
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing metadata field', () => {
    const { metadata, ...withoutMetadata } = validReviewReport;
    expect(ReviewReportSchema.safeParse(withoutMetadata).success).toBe(false);
  });

  it('rejects a malformed nested fileReview (bad codeQuality)', () => {
    const result = ReviewReportSchema.safeParse({
      ...validReviewReport,
      fileReviews: [
        {
          ...validReviewReport.fileReviews[0],
          codeQuality: { ...validCodeQuality, overallScore: 999 }
        }
      ]
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON Schema exports (for SDK structured outputs)
// ---------------------------------------------------------------------------

describe('JSON Schema exports', () => {
  it('CodeQualityResultJSONSchema is an object schema with the expected properties', () => {
    expect(CodeQualityResultJSONSchema).toMatchObject({ type: 'object' });
    const props = (CodeQualityResultJSONSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining(['file', 'issues', 'overallScore', 'summary'])
    );
  });

  it('TestCoverageResultJSONSchema is an object schema with the expected properties', () => {
    expect(TestCoverageResultJSONSchema).toMatchObject({ type: 'object' });
    const props = (TestCoverageResultJSONSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining(['file', 'hasTests', 'testFiles', 'untestedPaths', 'coverageEstimate', 'summary'])
    );
  });

  it('RefactoringSuggestionJSONSchema is an object schema with the expected properties', () => {
    expect(RefactoringSuggestionJSONSchema).toMatchObject({ type: 'object' });
    const props = (RefactoringSuggestionJSONSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(props ?? {})).toEqual(expect.arrayContaining(['file', 'suggestions', 'summary']));
  });

  it('ReviewReportJSONSchema is an object schema with the expected top-level properties', () => {
    expect(ReviewReportJSONSchema).toMatchObject({ type: 'object' });
    const props = (ReviewReportJSONSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining(['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata'])
    );
  });

  it('none of the JSON schemas have an unresolved $ref at the root', () => {
    for (const schema of [
      CodeQualityResultJSONSchema,
      TestCoverageResultJSONSchema,
      RefactoringSuggestionJSONSchema,
      ReviewReportJSONSchema
    ]) {
      expect(Object.keys(schema)).not.toContain('$ref');
    }
  });
});
