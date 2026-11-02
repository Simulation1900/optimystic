// Schema migrations, applied in order when the app starts. Never edit one that has shipped; add a new one.

const rowMeta = `
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer REFERENCES users(id) ON DELETE SET NULL`;

export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'init',
    sql: `
-- Rows keep the order they were added in (the planner never reorders).
CREATE SEQUENCE row_sort_seq;

CREATE TABLE users (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,               -- sha256 of the cookie token
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE months (
  key          text PRIMARY KEY CHECK (key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  copied_from  text,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  baseline     numeric(12,2) NOT NULL DEFAULT 4537,  -- card spending before the budget, for comparison
  ${rowMeta}
);

CREATE TABLE accounts (
  month_key        text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  account_key      text NOT NULL,
  name             text NOT NULL,
  balance          numeric(12,2) NOT NULL DEFAULT 0,
  monthly_deposit  numeric(12,2) NOT NULL DEFAULT 0,
  color            text NOT NULL DEFAULT '',
  sort             bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, account_key)
);

CREATE TABLE bills (
  month_key      text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  id             text NOT NULL,
  name           text NOT NULL,
  amount         numeric(12,2) NOT NULL DEFAULT 0,
  account_key    text,
  recurring      boolean NOT NULL DEFAULT true,
  due_day        smallint CHECK (due_day BETWEEN 1 AND 31),
  paid           boolean NOT NULL DEFAULT false,
  loan_applied   jsonb,
  heloc_applied  jsonb,
  sort           bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, id)
);

CREATE TABLE loans (
  month_key         text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  loan_key          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('car', 'home', 'other')),
  name              text NOT NULL,
  lender            text NOT NULL DEFAULT '',
  balance           numeric(12,2) NOT NULL DEFAULT 0,
  apr               numeric(8,4) NOT NULL DEFAULT 0,
  payment           numeric(12,2) NOT NULL DEFAULT 0,
  escrow            numeric(12,2) NOT NULL DEFAULT 0,
  original          numeric(12,2) NOT NULL DEFAULT 0,
  opened            text NOT NULL DEFAULT '',
  term_months       numeric(6,1) NOT NULL DEFAULT 0,
  vin               text NOT NULL DEFAULT '',
  purchase_price    numeric(12,2) NOT NULL DEFAULT 0,
  value             numeric(12,2) NOT NULL DEFAULT 0,
  value_as_of       text NOT NULL DEFAULT '',
  value_change_pct  numeric(8,4) NOT NULL DEFAULT 0,
  value_estimated   boolean NOT NULL DEFAULT false,
  bill_name         text NOT NULL DEFAULT '',
  custom_payment    numeric(12,2) NOT NULL DEFAULT 0,
  sort              bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, loan_key)
);

CREATE TABLE heloc (
  month_key       text PRIMARY KEY REFERENCES months(key) ON DELETE CASCADE,
  credit_limit    numeric(12,2) NOT NULL DEFAULT 80000,
  apr             numeric(8,4) NOT NULL DEFAULT 8,
  opened          text NOT NULL DEFAULT '2025-05',
  draw_years      numeric(5,2) NOT NULL DEFAULT 10,
  repay_years     numeric(5,2) NOT NULL DEFAULT 10,
  balance         numeric(12,2) NOT NULL DEFAULT 0,
  available       numeric(12,2) NOT NULL DEFAULT 80000,
  ytd_interest    numeric(12,2) NOT NULL DEFAULT 0,
  custom_payment  numeric(12,2) NOT NULL DEFAULT 0,
  ${rowMeta}
);

CREATE TABLE heloc_draws (
  month_key    text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  id           text NOT NULL,
  account_key  text NOT NULL,
  amount       numeric(12,2) NOT NULL,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  sort         bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, id)
);

CREATE TABLE budget_cards (
  month_key  text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  card_key   text NOT NULL,
  name       text NOT NULL,
  bill_name  text NOT NULL DEFAULT '',
  color      text NOT NULL DEFAULT '',
  sort       bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, card_key)
);

CREATE TABLE budget_categories (
  month_key      text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  cat_key        text NOT NULL,
  name           text NOT NULL,
  monthly_limit  numeric(12,2) NOT NULL DEFAULT 0,
  card_key       text NOT NULL DEFAULT '',
  sort           bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, cat_key)
);

CREATE TABLE card_expenses (
  month_key           text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  id                  text NOT NULL,
  date                date NOT NULL,
  description         text NOT NULL,
  amount              numeric(12,2) NOT NULL,           -- returns are negative
  cat_key             text NOT NULL DEFAULT '',
  card_key            text NOT NULL DEFAULT '',
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'sync')),
  import_fingerprint  text,
  sort                bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  ${rowMeta},
  PRIMARY KEY (month_key, id)
);
CREATE INDEX card_expenses_fp ON card_expenses(month_key, import_fingerprint);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  table_name  text NOT NULL,
  month_key   text,
  row_key     text,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb
);
CREATE INDEX audit_log_at ON audit_log(at DESC);
`
  },
  {
    id: 2,
    name: 'category memory',
    sql: `
-- Whether a person chose this expense's category (CSV guesses don't teach the category memory).
ALTER TABLE card_expenses ADD COLUMN cat_chosen boolean NOT NULL DEFAULT false;
UPDATE card_expenses SET cat_chosen = true WHERE source = 'manual';
CREATE INDEX card_expenses_chosen ON card_expenses(updated_at) WHERE cat_chosen;
`
  },
  {
    id: 3,
    name: 'transfers',
    sql: `
-- Money moved between two accounts in a month (counts in left-after-bills; balances untouched).
CREATE TABLE transfers (
  month_key    text NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  id           text NOT NULL,
  from_key     text NOT NULL,
  to_key       text NOT NULL,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  note         text NOT NULL DEFAULT '',
  recurring    boolean NOT NULL DEFAULT false,
  done         boolean NOT NULL DEFAULT false,
  sort         bigint NOT NULL DEFAULT nextval('row_sort_seq'),
  version      integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   integer REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (month_key, id),
  CHECK (from_key <> to_key)
);
`
  },
  {
    id: 4,
    name: 'card sync',
    sql: `
-- The bank's id for charges brought in or matched by card sync (SimpleFIN).
ALTER TABLE card_expenses ADD COLUMN external_id text;
CREATE INDEX card_expenses_external ON card_expenses(external_id) WHERE external_id IS NOT NULL;

-- One SimpleFIN connection; the access URL is stored encrypted with SYNC_KEY.
CREATE TABLE bank_connections (
  id               serial PRIMARY KEY,
  access_url_enc   text NOT NULL,
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_sync_at     timestamptz,
  last_error       text,
  last_result      jsonb
);

-- Each SimpleFIN account, and the planner card it feeds (null = ignored).
CREATE TABLE bank_links (
  connection_id  integer NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  sf_account_id  text NOT NULL,
  name           text NOT NULL DEFAULT '',
  org            text NOT NULL DEFAULT '',
  balance        numeric(12,2),
  balance_date   timestamptz,
  card_key       text,
  PRIMARY KEY (connection_id, sf_account_id)
);
`
  },
  {
    id: 5,
    name: 'push notifications',
    sql: `
-- Small app-wide settings (the push notification keys live here; they're made on first use).
CREATE TABLE app_settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

-- Devices that turned on notifications.
CREATE TABLE push_subscriptions (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);
`
  }
];
