# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) for this repository.

When reporting, include:
- What you found
- How to reproduce it
- What an attacker could do with it

## Scope and service boundaries

This service is the off-chain indexer and read API for OurDAO. As documented in the README security notes, it is strictly read-only with respect to the chain: it never holds a private key, never signs, and never submits transactions. Reports should be evaluated in that context (for example: data integrity, authentication/authorization, API exposure, injection, denial-of-service, or information disclosure affecting this service), not as a signing/custody compromise of on-chain funds by this backend.
