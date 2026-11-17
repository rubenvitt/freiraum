-- E0: Personen, Einladungen, Passkeys, Sitzungen.
-- Zeitpunkte immer timestamptz. Tokens werden nur als SHA-256-Hash gespeichert.

create table persons (
  id               uuid primary key default gen_random_uuid(),
  display_name     text not null check (length(trim(display_name)) between 1 and 100),
  -- WebAuthn user.id (zufällig, ohne Personenbezug), base64url
  webauthn_user_id text not null unique,
  created_at       timestamptz not null default now()
);

create table invitations (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references persons (id) on delete cascade,
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table passkeys (
  -- Credential-ID, base64url
  id            text primary key,
  person_id     uuid not null references persons (id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0 check (counter >= 0),
  transports    text[] not null default '{}',
  device_type   text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up     boolean not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_person_id_idx on passkeys (person_id);

create table webauthn_challenges (
  id             uuid primary key default gen_random_uuid(),
  purpose        text not null check (purpose in ('registration', 'authentication')),
  challenge      text not null,
  invitation_id  uuid references invitations (id) on delete cascade,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  check ((purpose = 'registration') = (invitation_id is not null))
);
create index webauthn_challenges_expires_at_idx on webauthn_challenges (expires_at);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references persons (id) on delete cascade,
  token_hash    bytea not null unique,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index sessions_person_id_idx on sessions (person_id);
