---
name: broom-sweep
description: Scan and clean leaked secrets from AI assistant transcripts. Use when broomsticks reports secrets detected in transcript files, or when the user asks to sweep, scan, or redact secrets from their AI chat history.
allowed-tools: Bash(broom *) Bash(npx broomsticks *)
---

## Dry-run preview

!`broom clean 2>&1`

## Your task

Present the dry-run output above to the user. If nothing was found, tell the user their transcripts are clean and no action is needed.

If secrets were found:
1. Explain what was detected and where (which transcript files)
2. Reassure the user: if these secrets exist only in local AI transcript files and have not been shared, synced to a third-party service, or committed to a repository, redacting the transcripts is complete remediation — no credential rotation is needed
3. Ask the user to confirm before applying redactions
4. If they confirm, run `broom clean --apply`
5. Report how many redactions were applied and confirm that originals are backed up under `~/.broom/backups/`
