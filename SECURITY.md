# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory.

This keeps the report confidential until a fix is released. Please don't open a public issue for security vulnerabilities.

## Supported Versions

This project is actively maintained. Security fixes are applied to the latest version on `main` only.

## Security Updates

### 2026-04-09
- Updated `hono` and `@hono/node-server` to resolve moderate severity CVEs:
  - [GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m): Middleware bypass via repeated slashes in serveStatic
  - [GHSA-26pp-8wgv-hjvm](https://github.com/advisories/GHSA-26pp-8wgv-hjvm): Missing validation of cookie name on write path in setCookie()
  - [GHSA-r5rp-j6wh-rvv4](https://github.com/advisories/GHSA-r5rp-j6wh-rvv4): Non-breaking space prefix bypass in cookie name handling in getCookie()
  - [GHSA-xpcf-pg52-r92g](https://github.com/advisories/GHSA-xpcf-pg52-r92g): Incorrect IP matching in ipRestriction() for IPv4-mapped IPv6 addresses
  - [GHSA-xf4j-xp2r-rqqx](https://github.com/advisories/GHSA-xf4j-xp2r-rqqx): Path traversal in toSSG() allows writing files outside output directory
  - [GHSA-wmmm-f939-6g9c](https://github.com/advisories/GHSA-wmmm-f939-6g9c): Middleware bypass via repeated slashes in serveStatic
- Updated `lodash` to resolve high severity CVEs:
  - [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc): Code injection via _.template imports key names
  - [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh): Prototype pollution via array path bypass in _.unset and _.omit
