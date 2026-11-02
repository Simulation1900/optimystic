# Bill Planner (optimystic)

The household Bill Planner as a private, self-hosted web app: one shared copy of the numbers that both logins
open from a phone or a laptop, installable to the home screen. It does everything the single-file HTML planner
does (bills on accounts, left-over forecast, HELOC and loans with payoff options, the card budget with Chase and
BoA CSV import, new months), and reproduces its figures to the cent.

```
packages/core   the planner's rules as plain functions (no database, no screens), shared by server and app
apps/api        Fastify + PostgreSQL: logins, months as rows with versions, the JSON API, serves the web app
apps/web        React + Vite installable web app (bottom tabs on phones, drag and drop on laptops)
docker/         compose.yml for ZimaOS (app, PostgreSQL 16, nightly backups) and .env.example
e2e/            Playwright tests at iPhone and laptop sizes
fixtures/       made-up backup and Chase CSV used by the tests
```

## How it works

Every change (mark a bill paid, move it, draw on the HELOC, add an expense) is an *op* defined in
`packages/core/src/ops.ts`. The phone applies the op to its copy at once, so the screen updates instantly, and
sends it to the server. The server locks that month, loads it, checks the row's `version` (409 if someone else
changed it first), applies the same op with the same code, saves only the rows that changed, writes the audit
log, and answers with the whole month and its totals. Offline, ops wait in the browser and are sent when the
connection comes back.

## Business rules

These are the rules from the HTML planner, implemented in `packages/core` and tested in
`packages/core/test/rules.test.ts`:

1. **Account math.** Ending balance (the HTML planner's "left after bills") = starting balance + monthly deposit − every bill on that account, paid or not,
   + transfers in − transfers out.
   Household left over = all balances + all deposits − all bills.
2. **Paid is a marker.** Checking a bill paid never changes an account balance.
3. **Except loan bills.** A bill linked to a loan, or named HELOC, applies its payment to that loan when checked.
   Unchecking, editing the amount, moving, deleting or relinking reverses exactly what was applied.
4. **Loan payment split.** Escrow first, then interest = balance × APR ÷ 12, the rest to principal (never more than
   the balance).
5. **HELOC payment split.** Interest = balance × APR × days in the month ÷ 365; the rest goes to principal and
   raises available credit; the interest is added to interest paid YTD.
6. **HELOC schedule.** Interest-only during the draw period, then equal payments over the repayment period.
   Payoff options: minimum, by draw end, 5 years, 3 years, custom; each rounded up to the cent.
7. **HELOC draws.** A draw adds to the account and the HELOC balance and lowers available credit, never past the
   limit. Cover shortfalls draws each account's negative left-after-bills. Draws can be undone in their month.
8. **Loans.** Payoff dates and interest from a month-by-month run of the balance. Equity = estimated value −
   balance, with the value changing by its yearly percentage. A contract check compares the balance with the
   original schedule.
9. **New month.** Copies recurring bills, all unpaid (one-time expenses only if asked). Starting balances:
   last month's ending balance (default), same, or $0; saved monthly deposits carry over. Loans and HELOC carry their balances; HELOC draws and card expenses start empty.
10. **Card bills.** On a new month each card's linked bill becomes projected spending (spent + unspent limits of
    that card's categories), actual spending, or is left alone.
11. **Card budget.** Calendar months. A category's spent = its expenses (returns negative). A card's spent = the
    expenses placed on it.
12. **CSV import.** Finds the date, description and amount columns (or debit and credit), skips payments, flips the
    sign when purchases are negative, files each line in the month of its *transaction date*, and guesses the
    category: first from what the household filed that store under before (below), then the keyword rules. A line already logged isn't added again, but two identical real charges stay two. **Lines dated in a
    month the planner doesn't have yet are skipped and counted** ("3 skipped: create that month first").
13. **Transfers.** Money moved between two of the household's accounts in a month counts against the "from" account's
    left-after-bills and adds to the "to" account's. Balances aren't changed (they come from the bank) and household
    left over doesn't move; "done" is only a marker. Monthly transfers are copied, not done, into each new month;
    removing an account removes its transfers. A short account can be covered by a transfer from the account with
    the most to spare, as well as by a HELOC draw.
14. **Category memory.** When someone picks or changes an expense's category, the app remembers that store
    (order and store numbers stripped, so "AMAZON MKTPL*5P5JM4NC2" and "AMAZON MKTPL*629QL7H33" match) across
    every month and both logins. Quick-add and CSV import suggest that category before the keyword rules; the
    latest choice wins. CSV guesses that nobody changed don't teach it anything.
15. **Old backups.** Amounts an earlier planner version subtracted from balances (`balanceApplied`) are added back
    on import.

### Notes on the spec's test figures

The Chase figures in the spec's Testing table come from statement-cycle downloads, not calendar months:

| Spec said | Figure | What it is |
| --- | --- | --- |
| Chase *October* CSV import, net of returns | $3,079.38 | The whole Oct 31 download (9/22–10/21), net of 2 returns |
| *October* statement purchases | $3,155.02 | The same download's purchases before returns |
| *September* statement purchases | $1,588.51 | The Nov 1 download (8/21–9/22) before its 2 credits |

Filed by calendar month (rule 11) the two downloads give **August $488.03, September $1,290.81 and October
$2,835.73**. All of these are tested against the real files when `PRIVATE_FIXTURES` is set (below).

## Development

Needs Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
```

```bash
createdb planner && createdb planner_test && createdb planner_e2e   # owned by a "planner" user, password "planner"
```

```bash
DATABASE_URL=postgres://planner:planner@localhost:5432/planner pnpm dev:api   # API on :8080
```

```bash
pnpm dev:web   # app on :5173, /api proxied to :8080
```

Tests:

```bash
pnpm typecheck && pnpm test      # core rules + API against planner_test
```

```bash
pnpm --filter @optimystic/web build && pnpm --filter @optimystic/api build && pnpm test:e2e
```

The household's real exports are never committed. To also check the spec's figures against them, point
`PRIVATE_FIXTURES` at a folder with the Nov 1 backup and the two Chase `*_Activity_*.csv` downloads:

```bash
PRIVATE_FIXTURES=~/planner-exports pnpm test
```

## Deploying on ZimaOS (Motherboxx)

GitHub Actions runs every test on each push and, for a tag like `v1.0.0`, builds the x86 image
`ghcr.io/simulation1900/optimystic:1.0.0`. The repository is private, so the package is too: either make the
package public under GitHub → Packages → optimystic → Package settings, or log the box in once with
`sudo docker login ghcr.io` (a personal access token with `read:packages`).

1. SSH into the box and create the folders:

   ```bash
   sudo mkdir -p /DATA/AppData/bill-planner /DATA/mnt/disk2/backups/bill-planner
   ```

   Check there's room on the NVMe first with `df -h /DATA`.

2. Copy `docker/compose.yml` and `docker/.env.example` (as `.env`) into `/DATA/AppData/bill-planner`. Fill in
   `.env` with two secrets from `openssl rand -hex 32`, then lock it down:

   ```bash
   sudo chmod 600 /DATA/AppData/bill-planner/.env
   ```

3. Start it (ZimaOS has no `docker compose` plugin; use the binary in `/DATA`):

   ```bash
   cd /DATA/AppData/bill-planner && sudo /DATA/docker-compose up -d
   ```

4. Turn on HTTPS: in the Tailscale admin console enable MagicDNS and HTTPS certificates, then:

   ```bash
   sudo docker exec tailscale tailscale serve --bg --https=8443 http://192.168.0.115:8085
   ```

5. With Tailscale on, open `https://zimaos.tail057064.ts.net:8443`, create the owner login, then Settings →
   Backups → Import backup with your latest `bill-planner-backup-*.json`. The check screen must show every figure
   matching before you rely on the app. Add the second login under Settings → Logins, and use "Add to Home Screen"
   from that address on each phone.

The app only works at its HTTPS address: its session cookie is `Secure`, and writes are refused unless they come
from `PUBLIC_URL`. `http://192.168.0.115:8085` loads but can't keep you signed in.

**Updates:** change the image tag in `compose.yml`, then:

```bash
cd /DATA/AppData/bill-planner && sudo /DATA/docker-compose pull && sudo /DATA/docker-compose up -d
```

Database migrations run when the app starts.

## Card sync (SimpleFIN)

Read-only syncing of the two credit cards' charges into the Card budget, through SimpleFIN Bridge (about $15 a
year). It never reads or changes the checking and savings accounts.

1. Add `SYNC_KEY` (from `openssl rand -hex 32`) to `.env` and restart the app. It encrypts the saved connection;
   changing it later means connecting again.
2. In SimpleFIN Bridge, connect only the Chase and BoA card logins, then create a setup token.
3. In the app, Settings → Card sync, paste the token (owner only; a token works once), then choose which SimpleFIN
   account is which card. Anything left on "Ignore" is never read into the planner.

It syncs at 6 AM and 6 PM (`SYNC_TIMES=06:00,18:00`, household time zone) and on Sync now, asking for the last 10
days so late-posting charges are caught. Charges are filed by transaction date like CSV import, with the category
memory and keyword rules. Pending charges wait until they post, card payments are skipped, returns come in as
credits. A charge already brought in by CSV (same card and amount, same store, within 5 days) is matched rather
than added, and two identical real charges stay two. When SimpleFIN reports a problem (a bank needing you to sign
in again, a revoked connection) the Card budget tab and Settings show it; nothing else changes and CSV import still
works. Disconnect deletes the saved connection; revoke it in the SimpleFIN Bridge dashboard too.

## Backups and restore

- The `backup` container dumps the database nightly to `/DATA/AppData/bill-planner/backups` (30 days kept) and
  copies each dump to `/DATA/mnt/disk2/backups/bill-planner`.
- Settings → Backups → Export downloads the same JSON as the HTML planner, readable anywhere.
- Restore a dump:

  ```bash
  sudo docker stop bill-planner
  ```

  ```bash
  sudo docker exec -i bill-planner-db pg_restore -U planner -d planner --clean < planner-2026-11-01.dump
  ```

  ```bash
  sudo docker start bill-planner
  ```

- Once a quarter, restore last night's dump into a spare copy of the stack to prove it works.

## Security

- Tailscale keeps the app off the public internet; never forward a router port to it.
- Port 8085 is still reachable from anything on the home network over plain HTTP (that's the address
  `tailscale serve` forwards to). If the `tailscale` container uses host networking, close that gap by publishing
  `"127.0.0.1:8085:8080"` in `compose.yml` and pointing `tailscale serve` at `http://127.0.0.1:8085`.
- Create the owner login right after the first start: until an owner exists, anyone who can reach the app can.
- Its own logins on top: argon2id password hashes, sign-in rate-limited (10 attempts per 15 minutes per address
  and per email; `X-Forwarded-For` is ignored unless `TRUST_PROXY` lists the proxy's address),
  signed HttpOnly + Secure + SameSite=Lax session cookies, writes checked against `PUBLIC_URL`.
- The database port is never published; secrets live only in `.env`.
- Only the owner can load a backup, delete a month, replace a month with a copy, or add and remove logins.
- Signing out clears the device's offline copy of the planner.

Light and dark mode follow the device by default; the sun/moon button in the header flips them, and Settings →
Appearance can pin Light, Dark or "Match this device" (saved per device).
- Every change is in the audit log (Settings → Recent changes) with who made it and the before/after values.
