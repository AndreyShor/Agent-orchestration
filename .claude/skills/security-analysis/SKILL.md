---
description: Security-focused code review covering OWASP Top 10 vulnerabilities and secure coding practices
---

# Security Analysis

Expert in application security review. Applies to every file reviewed, regardless of
language — invoke this skill in addition to any language-specific skill.

## Injection
- SQL/NoSQL injection: string-concatenated queries instead of parameterized queries/ORM methods
- Command injection: `exec`/`spawn`/`child_process` calls built from unsanitized input
- Path traversal: user-controlled input reaching `fs.readFile`/`path.join` without normalization
  or an allow-list check
- Template/eval injection: `eval()`, `new Function()`, or template engines rendering raw user input

## Cross-Site Scripting & Output Encoding
- Unescaped user input rendered into HTML (`innerHTML`, `dangerouslySetInnerHTML`, string-built HTML)
- Missing output encoding when reflecting input back in responses, logs, or error messages

## AuthN / AuthZ
- Missing or client-side-only authorization checks before a sensitive action
- Broken object-level authorization (IDOR): fetching/mutating a resource by ID without verifying
  the caller owns/can access it
- Hardcoded credentials, API keys, or secrets in source (even in comments or test fixtures)
- Weak or missing password hashing (plaintext, unsalted MD5/SHA1 instead of bcrypt/argon2/scrypt)
- JWT/session handling: missing expiry, missing signature verification, trusting client-supplied claims

## Data Handling
- Sensitive data (passwords, tokens, PII) logged in plaintext
- Insecure deserialization of untrusted input (`JSON.parse` is generally fine; flag custom
  deserializers, `pickle`-equivalents, or `eval`-based parsing)
- Prototype pollution via unguarded recursive merge/assign of user-controlled objects
- Missing input validation at a trust boundary (API handler, form submission, file upload)

## Transport & Config
- Disabled TLS certificate verification
- Overly permissive CORS (`Access-Control-Allow-Origin: *` alongside credentialed requests)
- Dependencies with known CVEs if version info is visible (flag for manual audit, don't guess versions)

## Severity Mapping
- **critical**: directly exploitable now (injection, auth bypass, hardcoded secret, IDOR on
  sensitive data)
- **high**: exploitable under realistic conditions, or a missing control that is the only
  thing standing between input and a sink
- **medium**: defense-in-depth gap (e.g. missing rate limiting, verbose error messages)
- **low**/**info**: hardening suggestions with no realistic near-term exploit path

## Output:
For each finding provide:
1. The vulnerability class (map to the category list above)
2. The exact vulnerable line(s) and the untrusted input's path to that sink
3. A concrete, non-exploit-code fix (parameterized query, sanitizer call, allow-list, etc.)
4. Severity using the mapping above
