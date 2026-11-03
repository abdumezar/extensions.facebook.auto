# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

## Reporting a vulnerability

Do not report security problems in public issues, discussions or pull requests.

Use GitHub's private vulnerability reporting instead:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability** (Security Advisories).
3. Describe the problem, the affected version, and steps to reproduce it.

Only the maintainers can see the report. You will get an acknowledgement as soon as one of them reads it, and updates as the fix progresses. Please give us reasonable time to ship a fix before you disclose the problem publicly. You will be credited in the advisory if you want to be.

## What counts

Examples of in-scope problems:

- Anything that exposes a user's Facebook session, cookies, tokens or stored data to a web page, another extension or a third party.
- Ways to make the extension act outside the pages and permissions it declares.
- Flaws in how updates are verified and installed.
- Cross-site scripting or injection in the extension's own pages.

Out of scope: Facebook changing its own behaviour (open a normal issue if an operation stops working), and anything that requires an attacker who already controls the user's machine or browser profile.

## What not to include

Do not attach real session data, cookies, tokens, HAR files or other people's personal information to a report. Describe the problem or use synthetic data.
