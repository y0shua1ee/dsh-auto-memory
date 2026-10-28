# Security

`dsh-auto-memory` stores model- and user-writable text that is injected into future model contexts. Treat memory and rule files as **untrusted context**, not as enforced configuration.

## Threat model

- **Prompt injection through memory.** The model can write memory files, and those files are re-injected later. A malicious instruction stored in memory can influence later sessions. Keep the memory root private, review `MEMORY.md` periodically, and never store credentials.
- **Prompt injection through repository rules.** Project rules are read from the repository. They are framed as project context, but a cloned repository can still contain misleading text. Path-scoped rules are not loaded until matching files are touched; external symlinks in project rule directories are skipped.
- **Local file access.** The plugin writes only under the configured `$DSH_HOME` memory root. It refuses traversal, hidden segments, non-`.md` files, symlinks inside the memory root, and writes above the configured limits.
- **No execution.** Rules and memories are text. The plugin does not execute rule content.

## Reporting

Please report security issues through GitHub Security Advisories on this repository rather than a public issue. Include the affected version, a minimal reproduction, and the impact.
