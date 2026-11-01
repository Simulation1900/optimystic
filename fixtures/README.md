# Test fixtures

Made-up data in the same shapes as the real files:

- `sample-backup.json` is a `bill-planner-backup-*.json` from the HTML planner, including an old
  `balanceApplied` marker (rule 13) and a bill with no account.
- `sample-card-activity.csv` is a Chase activity download: a payment line to skip, a return, two identical
  same-day charges that must both be kept, a quoted description with a comma, and lines in three months.

The household's real exports are never committed. To also run the spec's figures against them, point
`PRIVATE_FIXTURES` at a folder holding the two Chase `*_Activity_*.csv` downloads (Oct 31 and Nov 1, 2026)
and the Nov 1 backup; those tests are skipped when the variable isn't set.
