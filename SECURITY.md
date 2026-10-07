# Security policy

## Reporting a vulnerability

Please report it in private, not in a public issue:
<https://github.com/nickolaiposs/friendspeak/security/advisories/new>
(the **Report a vulnerability** button under the repository's Security tab).

Say what is affected (the server, the desktop app, the admin dashboard, the release
pipeline), which version, and how to reproduce it. You can expect an answer within a week.
A fix is released as a new version, and the report is published as a security advisory
with credit to you, unless you'd rather not be named. Please give it 90 days, or until the
fix is released, before writing about it in public.

## Supported versions

Only the latest release gets fixes. Apps and servers update themselves to it, or say that
it's out (README → Automatic updates).

## What the project assumes

`AGENTS.md` (rule 9) and `docs/DECISIONS.md` describe the trust model: a server is for a
group of friends, joining takes an invite, and the host can read everything on their
server except direct messages. A report that a host can read their own server's channels
is not a vulnerability; a member doing what their role doesn't allow is.

## Checking a download

Every release after 1.1.8 carries signed build provenance (D64): which commit and which
run of the release workflow built each file. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify friendspeak-<version>-win-x64-setup.exe --repo nickolaiposs/friendspeak
gh attestation verify oci://ghcr.io/nickolaiposs/friendspeak:<version> --repo nickolaiposs/friendspeak
```
