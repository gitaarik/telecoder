#!/usr/bin/env bash
#
# Provision a separate Unix account to run a shared TeleCoder instance.
#
# The admin/guest split, the scope guard and the charter judge are supervision:
# they decide what needs a human's attention. None of them is a boundary. Claude
# still runs as the bot's Unix user with permissions bypassed, so "which files
# can this bot reach" is answered by Unix, not by TeleCoder — and the only way
# to answer it well is to run the shared bot as an account that owns nothing but
# the shared projects.
#
# What this does:
#   1. locks down the operator's home so the new account cannot read it
#   2. creates the account — no sudo, no docker (docker group is root-equivalent)
#   3. gives it a projects directory and a checkout of TeleCoder
#   4. installs a lingering systemd --user service so it survives a reboot
#
# What it deliberately leaves to you: authenticating Claude, and the bot token.
# Both are interactive, and neither belongs in a script's arguments.
#
# Usage:
#   sudo ./scripts/setup-shared-bot-user.sh --operator rik
#   sudo ./scripts/setup-shared-bot-user.sh --verify          # check, change nothing
#
set -euo pipefail

BOT_USER="telefriends"
OPERATOR=""
REPO_SRC=""
VERIFY_ONLY=false
HARDEN=true

# Resource ceilings. A shared bot runs builds, and a build with no ceiling on a
# machine that is already busy does not fail politely — it takes the other
# services down with it. Defaults leave roughly half of a 4-core / 8GB box for
# whatever else is running; override on a bigger machine.
MEM_HIGH="1G"     # soft: the kernel throttles and reclaims past this
MEM_MAX="2G"      # hard: OOM-kill the service, not the machine
CPU_QUOTA="200%"  # two cores' worth
TASKS_MAX="2048"  # builds fan out; too low breaks npm, too high is no limit

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^#\{1,2\} \{0,1\}//;$d'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user)     BOT_USER="${2:?--user needs a name}"; shift 2 ;;
    --operator) OPERATOR="${2:?--operator needs a name}"; shift 2 ;;
    --repo)     REPO_SRC="${2:?--repo needs a path}"; shift 2 ;;
    --no-harden) HARDEN=false; shift ;;
    --memory-max) MEM_MAX="${2:?--memory-max needs a value}"; shift 2 ;;
    --cpu-quota)  CPU_QUOTA="${2:?--cpu-quota needs a value}"; shift 2 ;;
    --verify)   VERIFY_ONLY=true; shift ;;
    -h|--help)  usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

# The operator is whoever owns the projects this account must NOT reach —
# normally the human running sudo.
[ -n "$OPERATOR" ] || OPERATOR="${SUDO_USER:-}"
[ -n "$OPERATOR" ] || die "could not infer --operator (no SUDO_USER); pass it explicitly"
id "$OPERATOR" >/dev/null 2>&1 || die "operator '$OPERATOR' is not a user on this machine"

OPERATOR_HOME="$(getent passwd "$OPERATOR" | cut -d: -f6)"
BOT_HOME="/home/$BOT_USER"
PROJECTS="$BOT_HOME/projects"

# ---------------------------------------------------------------------------
# Verify — the same checks whether run before or after provisioning.
# ---------------------------------------------------------------------------
verify() {
  local failures=0

  say "Operator home ($OPERATOR_HOME)"
  local mode; mode="$(stat -c %a "$OPERATOR_HOME")"
  if [ "$((8#$mode & 8#0001))" -eq 0 ]; then
    ok "mode $mode — other cannot traverse, so nothing inside is reachable"
  else
    warn "mode $mode — other has traverse; any world-readable file inside is reachable by path"
    local exposed
    exposed="$(find "$OPERATOR_HOME" -maxdepth 4 \( -name '.env' -o -name '.env.*' -o -name '*credentials*' -o -name '*.key' -o -name '*.pem' \) \
      -type f -perm -o=r 2>/dev/null | grep -v node_modules | grep -v '\.env\.example' | head -5)"
    [ -n "$exposed" ] && printf '      e.g. %s\n' $exposed
    failures=$((failures + 1))
  fi

  if id "$BOT_USER" >/dev/null 2>&1; then
    say "Account $BOT_USER"
    local groups; groups="$(id -nG "$BOT_USER")"
    ok "exists — groups: $groups"
    for danger in sudo wheel admin docker adm; do
      case " $groups " in
        *" $danger "*) warn "in '$danger' — that is root-equivalent, remove it"; failures=$((failures + 1)) ;;
      esac
    done

    # The question that matters, asked the only way worth trusting: actually try.
    say "Reachability from $BOT_USER"
    local probe leaked=0
    while IFS= read -r probe; do
      [ -n "$probe" ] || continue
      if sudo -u "$BOT_USER" test -r "$probe" 2>/dev/null; then
        warn "CAN READ $probe"
        leaked=$((leaked + 1))
      fi
    done <<EOF
$(find "$OPERATOR_HOME" -maxdepth 4 \( -name '.env' -o -name '*credentials*' -o -name '*.key' \) -type f 2>/dev/null | grep -v node_modules | grep -v '\.env\.example' | head -20)
$OPERATOR_HOME/.ssh/id_rsa
$OPERATOR_HOME/.ssh/id_ed25519
EOF
    if [ "$leaked" -eq 0 ]; then
      ok "cannot read any of the operator's secrets"
    else
      failures=$((failures + leaked))
    fi

    say "Resource use"
    local used; used="$(du -sh "$BOT_HOME" 2>/dev/null | cut -f1)"
    local free; free="$(df -h --output=avail "$BOT_HOME" 2>/dev/null | tail -1 | tr -d ' ')"
    ok "$BOT_HOME uses $used; $free free on that filesystem"
    # systemd caps memory, CPU and process count, but not disk. Filesystem
    # quotas are the only real answer there and they need the filesystem set up
    # for it, so this reports rather than enforces.
    warn "disk is not capped — set a filesystem quota if that matters to you"

    if sudo -u "$BOT_USER" sudo -n true 2>/dev/null; then
      warn "$BOT_USER has passwordless sudo — that defeats the whole exercise"
      failures=$((failures + 1))
    else
      ok "no passwordless sudo"
    fi
  else
    say "Account $BOT_USER does not exist yet"
  fi

  echo
  if [ "$failures" -eq 0 ]; then
    printf '\033[32mIsolation looks correct.\033[0m\n'
  else
    printf '\033[31m%d problem(s) above.\033[0m\n' "$failures"
    return 1
  fi
}

if [ "$VERIFY_ONLY" = true ]; then
  [ "$(id -u)" -eq 0 ] || die "--verify needs root (it tests reads as $BOT_USER)"
  verify
  exit $?
fi

[ "$(id -u)" -eq 0 ] || die "run me with sudo"

# ---------------------------------------------------------------------------
# 1. Harden the operator's home.
# ---------------------------------------------------------------------------
if [ "$HARDEN" = true ]; then
  say "Locking down $OPERATOR_HOME"
  before="$(stat -c %a "$OPERATOR_HOME")"
  chmod o-rx "$OPERATOR_HOME"
  ok "mode $before → $(stat -c %a "$OPERATOR_HOME") (other can no longer traverse)"

  # Belt and braces: a future chmod on the home directory shouldn't re-expose
  # every secret underneath it.
  tightened=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    chmod 600 "$f" && tightened=$((tightened + 1))
  done <<EOF
$(find "$OPERATOR_HOME" -maxdepth 4 \( -name '.env' -o -name '.env.bot*' -o -name '.env.local' \) -type f -perm -o=r 2>/dev/null | grep -v node_modules)
EOF
  ok "tightened $tightened dotenv file(s) to 0600"
fi

# ---------------------------------------------------------------------------
# 2. The account.
# ---------------------------------------------------------------------------
say "Account $BOT_USER"
if id "$BOT_USER" >/dev/null 2>&1; then
  ok "already exists"
else
  useradd --create-home --shell /bin/bash "$BOT_USER"
  passwd --lock "$BOT_USER" >/dev/null
  ok "created (password locked, no sudo, no docker)"
fi
chmod 750 "$BOT_HOME"

# Survives logout and reboot without anyone holding a session open.
loginctl enable-linger "$BOT_USER"
ok "lingering enabled — services start at boot"

install -d -o "$BOT_USER" -g "$BOT_USER" -m 750 "$PROJECTS"
ok "projects directory at $PROJECTS"

# ---------------------------------------------------------------------------
# 3. TeleCoder checkout.
# ---------------------------------------------------------------------------
say "TeleCoder checkout"
BOT_REPO="$BOT_HOME/telecoder"
if [ -d "$BOT_REPO/.git" ]; then
  ok "already at $BOT_REPO"
else
  if [ -n "$REPO_SRC" ]; then
    sudo -u "$BOT_USER" git clone --quiet "$REPO_SRC" "$BOT_REPO"
  else
    sudo -u "$BOT_USER" git clone --quiet https://github.com/gitaarik/telecoder.git "$BOT_REPO"
  fi
  ok "cloned to $BOT_REPO"
fi

say "Dependencies"
sudo -u "$BOT_USER" bash -lc "cd '$BOT_REPO' && npm ci --silent && npm run build --silent"
ok "installed and built"

# ---------------------------------------------------------------------------
# 4. Starter .env — the sharing settings filled in, the secrets left blank.
# ---------------------------------------------------------------------------
ENV_FILE="$BOT_REPO/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already present, left alone"
else
  say "Starter .env"
  cat > "$ENV_FILE" <<ENVEOF
# Fill in the two blanks below, then start the service.
TELEGRAM_BOT_TOKEN=
# Your Telegram id first, then your friends'.
ALLOWED_USER_IDS=
# The subset that approves prompts and owns lifecycle commands — just you.
ADMIN_USER_IDS=
# The group you share. Guests are confined to it.
ALLOWED_GROUP_IDS=
RESTRICT_TO_GROUPS=true

# The projects this bot exists for. Nothing else is on this account.
WORKSPACE_DIR=$PROJECTS

# The permission gate is a PreToolUse hook on the CLI, so it only runs on PTY.
CLAUDE_METHOD_DEFAULT=pty

# Supervision. All three default to on once ADMIN_USER_IDS names a subset;
# spelled out here so they are visible rather than implied.
TELECODER_PERMISSION_PROMPTS=1
SCOPE_GUARD=on
CHARTER_JUDGE=on
PERMISSION_PROMPT_TIMEOUT_MINUTES=10

BOT_NAME=TeleCoder Shared
BOT_MODE=prod
ENVEOF
  chown "$BOT_USER:$BOT_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "written to $ENV_FILE (mode 600)"
fi

# ---------------------------------------------------------------------------
# 5. systemd --user service.
# ---------------------------------------------------------------------------
say "systemd service"
UNIT_DIR="$BOT_HOME/.config/systemd/user"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 700 "$UNIT_DIR"
cat > "$UNIT_DIR/telecoder.service" <<UNITEOF
[Unit]
Description=TeleCoder (shared instance)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BOT_REPO
ExecStart=$(command -v node) $BOT_REPO/dist/index.js
# always, not on-failure: /restartbot works by exiting for systemd to bring the
# bot back, and an intentional `systemctl stop` is still a stop either way.
Restart=always
RestartSec=5
# 75 (EX_TEMPFAIL) is the code /restartbot exits with. Naming it here keeps an
# intentional restart out of the journal as "Failed with result 'exit-code'",
# which is worth the line the next time someone reads these logs to find out
# why the bot went away. Restart=always still restarts on it.
SuccessExitStatus=75
# Defence in depth behind the Unix account, chosen not to break dev work:
# the service cannot see the operator's home at all (not merely be refused by
# permissions), /usr and /etc are read-only, /tmp is its own. Deliberately NOT
# ProtectSystem=strict — that makes the whole tree read-only including /tmp,
# and a bot whose whole job is installing and building things would fail in
# ways nobody would enjoy diagnosing.
ProtectHome=tmpfs
BindPaths=$BOT_HOME
ProtectSystem=full
PrivateTmp=true
NoNewPrivileges=true
ProtectKernelTunables=true
RestrictSUIDSGID=true

# Ceilings. MemoryHigh throttles first so an ordinary large build slows down
# instead of being killed; MemoryMax is the backstop that keeps a runaway from
# taking the host with it. IOWeight below the default means this service yields
# disk to everything else rather than competing with it.
MemoryHigh=$MEM_HIGH
MemoryMax=$MEM_MAX
CPUQuota=$CPU_QUOTA
TasksMax=$TASKS_MAX
IOWeight=50

[Install]
WantedBy=default.target
UNITEOF
chown "$BOT_USER:$BOT_USER" "$UNIT_DIR/telecoder.service"
ok "unit at $UNIT_DIR/telecoder.service"

echo
verify || true

BOT_UID="$(id -u "$BOT_USER")"
cat <<NEXTEOF

$(printf '\033[36m==>\033[0m') Remaining steps — both interactive, so they are yours:

  1. Authenticate Claude as $BOT_USER:
       sudo -u $BOT_USER -i
       curl -fsSL https://claude.ai/install.sh | bash
       claude          # log in, then /exit

  2. Fill in TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, ADMIN_USER_IDS and
     ALLOWED_GROUP_IDS in $ENV_FILE

  3. Put the shared projects in $PROJECTS
     (and optionally a CHARTER.md there — the judge will pick it up)

  4. Start it:
       sudo -u $BOT_USER XDG_RUNTIME_DIR=/run/user/$BOT_UID systemctl --user enable --now telecoder
       sudo -u $BOT_USER XDG_RUNTIME_DIR=/run/user/$BOT_UID systemctl --user status telecoder

  5. In BotFather, turn privacy mode OFF for this bot so it sees group messages.

  Re-check isolation at any time with:
       sudo $0 --verify --user $BOT_USER --operator $OPERATOR
NEXTEOF
