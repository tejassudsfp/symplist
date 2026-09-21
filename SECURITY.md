# Security policy

## Supported versions

Symplist is a released, self-hostable application. Security fixes are applied to the latest `main` branch; there are no long-term support branches. If you run a deployment, update to the latest commit before reporting an issue.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, private artifacts, or exploit details in a public issue. Use GitHub's private reporting entry point at <https://github.com/tejassudsfp/symplist/security/advisories/new>. If private reporting is unavailable, open an issue containing only a request for a private contact channel, without vulnerability details or sensitive data.

Include:

- the affected revision (commit hash),
- reproduction steps using synthetic data,
- impact, and a suggested mitigation if you have one.

## Scope and ground rules

Test only systems you own or are authorized to assess. Do not access other users' content, send unsolicited emails, or run destructive testing.

## Handling

The maintainer will investigate and coordinate disclosure. No response-time guarantee or bounty program is currently offered. Security-relevant design constraints — encryption at rest, the durable executor's no-content-retention rule, cookie/CORS/CSRF handling, and the artifact-hostname boundary — are documented in [SELF_HOSTING.md](SELF_HOSTING.md) and the numbered notes; changes that weaken them will not be accepted.
