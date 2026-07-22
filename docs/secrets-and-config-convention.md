# Secrets & Configuration Convention

**Status**: Standard for all Node.js backends under `pluton-bridge/*`. Introduced by RIN-120.
**Scope**: `rango-intents` (this service), `depositron`, `clydner`, and every new Node.js backend added to the org.

> Adopted into this repo as the canonical reference. This repo's mounted secret path is
> `/run/secrets/rango_intents_env` and its explicit override var is `RANGO_INTENTS_ENV_FILE`.
> The loader, `config.yaml`, ignore rules, and the pino error-serializer fix below are the
> concrete adoption steps — track their state as a card, don't assume they are all in place yet.

Two layers, described separately: the **app** layer (how services read config and secrets) and the **deployment** layer (how those secrets get onto the servers in the first place).

---

## App layer

Two files, distinct roles, distinct locations.

### `config.yaml` — public configuration

- Structured, human-editable configuration: chain lists, endpoint tables, timeouts, feature flags, log levels — anything that is not a secret.
- Committed to git as a plain file. Anyone with repo read access can read it.
- Contains `${VAR}` interpolation for anywhere a secret needs to appear at runtime.

### Secret file — the credentials

- Contains atomic `KEY=VALUE` lines. Not structured, not committed.
- Mounted into the running Docker container at a fixed path — this is the **only** way secrets reach a running service.
- Never appears as a plaintext file on any developer laptop or on the host outside the running container's mount.

### `secret_reader.ts` — the loader

Every service reads secrets through one loader. It searches the following paths and returns the **first** one that exists:

1. Mounted secret file at `/run/secrets/<service>_env` (production / staging path) — the concrete name is per service, e.g. `/run/secrets/rango_intents_env` in rango-intents, `/run/secrets/depositron_env` in depositron.
2. `$<SERVICE>_ENV_FILE` (explicit override for CI or non-standard setups) — same per-service naming: `RANGO_INTENTS_ENV_FILE`, `DEPOSITRON_ENV_FILE`, etc.
3. `./.env` at the current working directory (developer laptop fallback).

The rest of the codebase reads through `ConfigService.get('KEY_NAME')`. Keys are `UPPER_SNAKE_CASE`; nested yaml keys flatten by joining with `_` (e.g. `redis.defaultTtlSeconds` → `REDIS_DEFAULT_TTL_SECONDS`). The name is the same regardless of where the value came from.

### Precedence for shared keys

When the same key appears in more than one source, later wins:

1. `config.yaml`
2. `.env` (if used — dev only)
3. Mounted secret file at `/run/secrets/<service>_env`

**The secret file overrides the `.env`, which overrides the `config.yaml`.** An operator can force any value by placing it in the secret file, without editing yaml or code.

### Reference implementation

`rango-intents/src/config/yaml_reader.ts` + `rango-intents/src/config/secret_reader.ts`. Depositron and clydner adopt the same loader (extracted to a shared module or copied per repo).

---

## Deployment layer

Secrets are stored **encrypted** in git, decrypted only in memory at deploy time, and written directly onto the target container's mount path. **After the initial encryption step, no server disk ever holds a plaintext secret file.**

### Storage: Ansible Vault, committed to git as ciphertext

- Secrets are held in `vault.yml` per environment inside the ops / infra repository.
- The file is encrypted with `ansible-vault` (AES-256, symmetric, password-derived key).
- The encrypted file is committed to git. Without the vault password, the file is opaque.
- Different vault passwords per environment (staging password ≠ production password), so blast radius of a leaked password is one environment.

### The one-time encryption step

When a new secret is added — or on initial adoption per repo — the plaintext value is placed into `vault.yml` **once**, encrypted immediately with `ansible-vault encrypt` / `ansible-vault edit`, and the ciphertext is committed. After that step the plaintext no longer exists on the person's disk. Every subsequent read or edit happens through `ansible-vault` commands which decrypt into memory, present in an editor buffer, and re-encrypt on save — never landing on the filesystem.

### Editing existing secrets

Only via ansible-vault commands, always in memory:

```bash
ansible-vault edit  group_vars/production/vault.yml   # in-memory edit + save re-encrypts
ansible-vault view  group_vars/production/vault.yml   # read-only decrypt to terminal
ansible-vault rekey group_vars/production/vault.yml   # change the vault password
```

**Never** decrypt with `ansible-vault decrypt <file>` (writes plaintext to disk). If a decrypted file appears in a working tree, it is a mistake to be reversed before commit.

### Deployment flow

Ansible playbook, run from an operator's machine:

1. Ansible reads the encrypted `vault.yml`, prompts for the vault password (or reads it from `--vault-password-file`), decrypts in memory.
2. Ansible SSHes to the target host.
3. Ansible writes the secret file directly to the host path that the container will mount — mode `0400`, owner root. Use `no_log: true` on the task so ansible's own verbose output does not echo the values.
4. `docker compose up -d <service>` starts the container with a read-only bind-mount of the host file into `/run/secrets/<service>_env`.
5. Ansible exits; the plaintext is gone from its process memory.

The plaintext exists in exactly three transient places during any full lifecycle: (a) an operator's editor buffer during `ansible-vault edit`; (b) ansible's process memory during a playbook run; (c) the host file at rest between deploys. Everywhere else — in git, in git history, in old clones, in backups — only ciphertext.

### Vault password

- Stored in a team password manager (1Password shared vault, or equivalent). Not committed anywhere.
- Distributed only to operators who need to run playbooks. A developer working on service code does not need the vault password — they use throwaway values locally.
- Rotated on operator turnover: `ansible-vault rekey <files>` re-encrypts with a new password; old clones become permanently sealed because no one has the old password.

---

## Development

Local dev never uses real secrets.

- `config.yaml` is committed — use the file that is already in the repo. Any locally-diverging value should come from `.env`, not from an edited-and-uncommitted `config.yaml`.
- Copy `.env.example` → `.env`, fill in **throwaway** values (a local Postgres password you pick, a fake API key that hits a mocked upstream, or a Ganache/Anvil-generated private key). `.env` is git-ignored.
- The developer never needs to touch ansible-vault. They never see a real staging or production credential.

---

## Ignore rules

Required in every repo's `.gitignore`:

```
.env
.env.*
!.env.example
/run/secrets/
*.log
log*.txt
```

Required in every repo's `.dockerignore`:

```
.env
.env.*
.git
node_modules
*.log
log*.txt
```

`config.yaml` is **not** ignored — it is a plain file committed to github (public configuration by definition, see App layer above).

---

## Never do

- **Never put a secret value in `docker-compose.yml` `environment:` or `env_file:`** — those propagate as environment variables, which are visible via `docker inspect` and inherit to every child process the container spawns. Bind-mount the file, always.
- **Never `ansible-vault decrypt` to disk** — even for a "quick look". Use `view` or `edit`. Any plaintext on disk defeats the point.
- **Never check in a plaintext `.env`, `config.yaml`, or `vault.yml`** — every commit is a permanent leak. Rotation must precede removal if it happens.
- **Never pass an `err` object to `logger.error(err, ...)`** — pino's default error serializer spreads every enumerable field, and typeorm's `QueryFailedError` carries the bound query parameters (which can include credentials). Pass `{ errorName: err.name, errorMessage: err.message }` explicitly.
