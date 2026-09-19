# Backup and recovery

**Headline finding of this audit.** Nightly backups had not run for
fifteen days, and the mechanism guaranteed nobody would find out.
Confirmed, fixed, and verified — details in §1.

---

## 1 · B-1 · P0 · CONFIRMED · FIXED — backups silently stopped on 4 September

**Commit:** `abf19a2` · **File:** `infra/deploy/scripts/backup.sh`

Observed on the server, 19 September:

```
=== cron installed? ===        1
=== backups present? ===
-rw------- 1 ubuntu ubuntu 2.5K Sep  4 00:24 souqi_deploy-20260904-002443.sql.gz
-rw------- 1 ubuntu ubuntu 1.3K Sep  4 00:24 souqi_userdb-20260904-002443.sql.gz
```

The cron was installed, `cron` was `active`, and the script was present
and executable. The installed line was:

```
15 3 * * * cd /opt/platform/stack && /usr/bin/env bash scripts/backup.sh \
           >> /var/log/souqi-backup.log 2>&1
```

`/var/log` is `root:syslog drwxrwxr-x`; the job runs as `ubuntu`:

```
$ ( : >> /var/log/souqi-backup.log )
bash: /var/log/souqi-backup.log: Permission denied
```

**Root cause.** The shell evaluates the redirect *before* running the
command. The redirect failed, so `backup.sh` never executed. No dump, no
error anywhere — the redirect that failed was the one meant to capture
the error. A perfectly healthy-looking crontab, cron daemon and script,
and fifteen days of nothing.

**How it was found.** Not by an alert. By listing `$BACKUP_DIR` and
noticing the newest file was two weeks old.

**Fix.** The log goes to `${BACKUP_DIR}/backup.log` — a directory this
script creates, `chmod 700`s, and which is owned by the user the job runs
as. The cron line also `mkdir -p`s it first.

**Verified** by running the new cron command *verbatim* on the server:

```
Dumping souqi_deploy          56K   souqi_deploy-20260919-191817.sql.gz
Dumping customer databases    8.0K  souqi_userdb-20260919-191817.sql.gz
Pruning dumps older than 14 days    removed 2
```

---

## 2 · What is covered

`backup.sh` dumps **two Postgres clusters**:

| Dump | Holds |
| --- | --- |
| `souqi_deploy-*` | platform deploy DB — projects, deployments, env vars, domains, logs, **and source archives** (`source_archives`, since S3 is unset) |
| `souqi_userdb-*` | the customer cluster — one database per project, **plus the roles that own them** |

Dumping roles matters and the script says why: the per-project roles *are*
the isolation, so a restore without them is a restore without the
isolation. It uses `pg_dumpall`, not `pg_dump`, for that cluster.

Not covered, correctly: container images. They rebuild from source.

Retention: 14 days, pruned on each run. Mode `0600`, directory `0700`.

## 3 · What is NOT covered

### B-2 · P0 · CONFIRMED · NOT FIXED — MongoDB is not backed up by anything in this repo

`grep -ci mongo infra/deploy/scripts/backup.sh` → **0**.

Mongo is the control plane: `projects`, `turns`, `agent_runs`, usage
meters, rate-limit counters, `aispend`, and uploaded blobs. None of it is
in either Postgres dump.

Whether it is protected at all depends on where it is hosted — a managed
Atlas cluster has its own snapshots; a self-hosted instance would have
nothing. **That was not determined in this pass**, and it must be, before
any production sign-off. If it is self-hosted, this is an unbacked
primary datastore.

### B-3 · P1 · CONFIRMED · NOT FIXED — backups live on the machine they protect

`/opt/platform/backups` is on the same VM and the same disk as the
databases. The script's own output says so: *"That covers a bad migration
or a dropped table, not a lost VM."* There is no off-host copy, no object
storage target, and no encryption at rest beyond file mode.

Losing the VM loses the backups with it.

### B-4 · P1 — no restore has ever been tested

Restore paths exist (`--restore`, `--restore-userdb`) and are documented
in the script header. **Neither was executed in this pass**, because a
restore drill needs a throwaway environment and explicit approval, and
must not run against live customer data.

**A backup is not verified until a restoration succeeds. By that standard
this system currently has no verified backup.**

### B-5 · P2 — no alerting

Nothing watches backup freshness. B-1 ran for fifteen days precisely
because of that. A check that the newest dump is under 48 hours old
would have caught it on day two.

---

## 4 · RPO / RTO

Stated as targets, not as measured facts.

| | Target | Reality today |
| --- | --- | --- |
| **RPO** Postgres | 24h (nightly) | 24h **now that cron works**; was ∞ for 15 days |
| **RPO** Mongo | 24h | **unknown** — see B-2 |
| **RTO** platform DB | < 1h | untested |
| **RTO** customer DBs | < 1h | untested |
| **RTO** whole VM loss | — | **unbounded** — backups are on the lost VM (B-3) |

---

## 5 · Recommended order of work

1. **Determine where Mongo is hosted and whether it is backed up.** (B-2)
   Nothing else in this document matters if the control plane is not
   protected.
2. **Copy dumps off the box.** (B-3) Even `rclone`/`scp` to one other
   location converts "lost VM" from total loss to a day's loss.
3. **Run one restore drill** into a throwaway stack and record the
   timings. (B-4) Until then RTO is a guess.
4. **Alert on backup age.** (B-5)
