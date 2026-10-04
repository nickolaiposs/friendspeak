#!/usr/bin/env bash
# Sets up friendspeak on a domain with real HTTPS: friendspeak behind Caddy, in
# Docker (deploy/docker-compose.yaml, D53). For a fresh VPS/droplet, or a
# machine at home with ports 80 and 443 forwarded to it.
#
#   From a checkout:   ./deploy/install.sh
#   On a new server:   curl -fsSL https://raw.githubusercontent.com/nickolaiposs/friendspeak/prod/deploy/install.sh -o install.sh
#                      bash install.sh
#
# It asks for what it needs. To run it without questions, pass --domain and --yes.
# Running it again in the same folder keeps .env and the Caddyfile, and updates
# the compose file and the images.

set -euo pipefail

REPO="${FRIENDSPEAK_REPO:-nickolaiposs/friendspeak}"
REF="${FRIENDSPEAK_REF:-prod}"

DOMAIN="${DOMAIN:-}"
SERVER_NAME="${SERVER_NAME:-}"
DIR=""
YES=0
AUTO_UPDATE=""
START=1

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain <name>     the domain or subdomain that points at this machine (chat.example.com)
  --name <name>       the server's name, as friends see it (default: friendspeak)
  --dir <folder>      where the stack's files go (default: /opt/friendspeak as root, else ~/friendspeak)
  --no-auto-update    don't run the Watchtower sidecar; new versions are only announced
  --no-start          write the files, don't start anything
  -y, --yes           don't ask; use the defaults for everything not given
  -h, --help          this text

While the repo and image are private, also set GITHUB_TOKEN (to download these
files) and GHCR_USER / GHCR_TOKEN (to pull the image) in the environment.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --name) SERVER_NAME="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --no-auto-update) AUTO_UPDATE=no; shift ;;
    --no-start) START=0; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Questions are read from the terminal, so the script also works piped into bash
if [ "$YES" = 0 ] && ! { : </dev/tty; } 2>/dev/null; then
  die "No terminal to ask questions on. Pass --domain <name> --yes to run without them."
fi
ask() { # ask <prompt> <default> → answer on stdout
  local answer=""
  if [ "$YES" = 1 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1${2:+ [$2]}: " answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}
confirm() { # confirm <prompt> <default y|n>
  local answer
  if [ "$YES" = 1 ]; then [ "$2" = y ]; return; fi
  if [ "$2" = y ]; then answer="$(ask "$1 (Y/n)" "")"; else answer="$(ask "$1 (y/N)" "")"; fi
  case "${answer:-$2}" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- Docker

if ! have docker; then
  [ "$(uname -s)" = Linux ] || die "Docker isn't installed. Install Docker Desktop (https://docs.docker.com/get-docker/) and run this again."
  [ "$(id -u)" = 0 ] || die "Docker isn't installed. Run this again as root (sudo bash $0) to install it, or install it yourself: https://docs.docker.com/engine/install/"
  confirm "Docker isn't installed. Install it now with Docker's own script (get.docker.com)?" y || die "Docker is needed."
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Is it running, and may this user use it? (Try: sudo bash $0)"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing: https://docs.docker.com/compose/install/linux/"

# ---------------------------------------------------------------- files

if [ -z "$DIR" ]; then
  if [ "$(id -u)" = 0 ]; then DIR=/opt/friendspeak; else DIR="$HOME/friendspeak"; fi
  # Run again from inside an installed stack: stay there
  if [ -f ./docker-compose.yaml ] && [ -f ./Caddyfile ] && [ -f ./.env ]; then DIR="$PWD"; fi
  DIR="$(ask "Folder for the stack's files" "$DIR")"
fi
mkdir -p "$DIR" "$DIR/assets-pack" "$DIR/assets-extra"
DIR="$(cd "$DIR" && pwd)"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fetch() { # fetch <file>: from next to this script if it's there, else from GitHub
  if [ -n "$SRC" ] && [ -f "$SRC/$1" ] && [ -f "$SRC/docker-compose.yaml" ]; then
    [ "$SRC" = "$DIR" ] || cp "$SRC/$1" "$DIR/$1"
    return
  fi
  local url="https://raw.githubusercontent.com/$REPO/$REF/deploy/$1"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$url" -o "$DIR/$1"
  else
    curl -fsSL "$url" -o "$DIR/$1"
  fi || die "Couldn't download $url. While the repo is private, set GITHUB_TOKEN to a token that can read it."
}

say "Writing the stack to $DIR"
fetch docker-compose.yaml
if [ -f "$DIR/Caddyfile" ] && [ "$SRC" != "$DIR" ]; then
  echo "  Caddyfile: kept the one that's there"
else
  fetch Caddyfile
fi

# ---------------------------------------------------------------- settings

random_hex() {
  if have openssl; then openssl rand -hex 32; else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; fi
}
env_get() { sed -n "s/^$1=//p" "$DIR/.env" 2>/dev/null | tail -n 1; }

if [ -f "$DIR/.env" ]; then
  echo "  .env: kept the one that's there (edit it to change settings)"
  DOMAIN="$(env_get DOMAIN)"
  [ -n "$DOMAIN" ] || die "$DIR/.env has no DOMAIN. Add a line like DOMAIN=chat.example.com"
else
  while :; do
    [ -n "$DOMAIN" ] || DOMAIN="$(ask "Domain that points at this machine (e.g. chat.example.com)" "")"
    # Forgive a pasted address
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##')"
    if printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$|^localhost$'; then break; fi
    [ "$YES" = 0 ] || die "--domain must be a name like chat.example.com"
    warn "That doesn't look like a domain name."
    DOMAIN=""
  done
  [ -n "$SERVER_NAME" ] || SERVER_NAME="$(ask "Server name, as friends see it" "friendspeak")"
  # Written in single quotes, so compose takes #, $ and spaces in it as they are
  SERVER_NAME="$(printf '%s' "$SERVER_NAME" | tr -d "'")"
  if [ -z "$AUTO_UPDATE" ]; then
    echo "  Automatic updates run a second container (Watchtower) that holds the Docker socket."
    if confirm "Install new friendspeak versions automatically (Sundays 06:00)?" y; then AUTO_UPDATE=yes; else AUTO_UPDATE=no; fi
  fi
  TZ_NAME="${TZ:-}"
  [ -n "$TZ_NAME" ] || TZ_NAME="$(cat /etc/timezone 2>/dev/null || true)"
  [ -n "$TZ_NAME" ] || TZ_NAME="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*zoneinfo/##p' || true)"
  [ -n "$TZ_NAME" ] || TZ_NAME=UTC

  umask 077
  {
    echo "# friendspeak settings (deploy/.env.example lists them all). After a change: docker compose up -d"
    echo "DOMAIN=$DOMAIN"
    echo "SERVER_NAME='$SERVER_NAME'"
    echo "TZ=$TZ_NAME"
    if [ "$AUTO_UPDATE" = yes ]; then
      echo "AUTO_UPDATE=on"
      echo "COMPOSE_PROFILES=autoupdate"
      echo "WATCHTOWER_TOKEN=$(random_hex)"
    else
      echo "AUTO_UPDATE=notify"
    fi
    echo "GITHUB_TOKEN=${GITHUB_TOKEN:-}"
    echo "GHCR_USER=${GHCR_USER:-}"
    echo "GHCR_TOKEN=${GHCR_TOKEN:-}"
    [ -z "${FRIENDSPEAK_IMAGE:-}" ] || echo "FRIENDSPEAK_IMAGE=$FRIENDSPEAK_IMAGE"
  } > "$DIR/.env"
  echo "  .env: written"
fi

# ---------------------------------------------------------------- DNS

# Caddy can only get a certificate once the domain reaches this machine. Only a
# warning: a home server behind a router, or a DNS proxy, looks different from here.
resolve() {
  if have getent; then getent ahosts "$1" | awk '{print $1}' | sort -u
  elif have dig; then dig +short A "$1"; dig +short AAAA "$1"
  elif have host; then host "$1" | awk '/has (IPv6 )?address/ {print $NF}'
  fi
}
if [ "$DOMAIN" != localhost ]; then
  say "Checking where $DOMAIN points"
  RESOLVED="$(resolve "$DOMAIN" 2>/dev/null | tr '\n' ' ' || true)"
  MY_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$RESOLVED" ]; then
    warn "$DOMAIN doesn't resolve yet. Add an A record for it${MY_IP:+ with the value $MY_IP} at your DNS provider."
    warn "Caddy keeps trying, so the certificate arrives by itself once the record is live."
  elif [ -n "$MY_IP" ] && ! printf '%s' " $RESOLVED" | grep -qF " $MY_IP "; then
    warn "$DOMAIN points at: $RESOLVED"
    warn "This machine's public address looks like: $MY_IP"
    warn "If that's not a proxy of yours, fix the A record, or HTTPS won't come up."
  else
    echo "  $DOMAIN → ${MY_IP:-$RESOLVED}"
  fi
fi

if [ "$START" = 0 ]; then
  say "Files are ready in $DIR. Start with: cd $DIR && docker compose up -d"
  exit 0
fi

# ---------------------------------------------------------------- start

cd "$DIR"
GHCR_USER_SET="$(env_get GHCR_USER)"
GHCR_TOKEN_SET="$(env_get GHCR_TOKEN)"
if [ -n "$GHCR_USER_SET" ] && [ -n "$GHCR_TOKEN_SET" ]; then
  printf '%s' "$GHCR_TOKEN_SET" | docker login ghcr.io -u "$GHCR_USER_SET" --password-stdin >/dev/null || warn "Signing in to ghcr.io failed"
fi

say "Pulling the images"
if ! docker compose pull; then
  IMAGE="$(env_get FRIENDSPEAK_IMAGE)"
  if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    warn "Couldn't pull everything; using the local image $IMAGE"
  else
    die "Couldn't pull the images. While the friendspeak image is private, set GHCR_USER and GHCR_TOKEN (a GitHub token with read:packages) in $DIR/.env and run this again."
  fi
fi

say "Starting"
docker compose up -d --remove-orphans

printf '  Waiting for friendspeak'
CID="$(docker compose ps -q friendspeak)"
STATE=starting
for _ in $(seq 60); do
  STATE="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || echo gone)"
  [ "$STATE" = starting ] || break
  printf '.'
  sleep 2
done
echo " $STATE"

docker compose logs --no-log-prefix --tail 60 friendspeak || true
[ "$STATE" = healthy ] || die "friendspeak didn't come up. See: cd $DIR && docker compose logs"
sleep 3
CADDY="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$(docker compose ps -aq caddy)" 2>/dev/null || echo gone)"
if [ "$CADDY" != "running 0" ]; then
  docker compose logs --no-log-prefix --tail 20 caddy || true
  die "Caddy isn't staying up ($CADDY). The lines above say why; a mistake in $DIR/Caddyfile is the usual cause."
fi

cat <<EOF

friendspeak is running at https://$DOMAIN

  - The lines above have the admin dashboard's address, and on the first start
    the admin key and the first invite. Copy the key now: it is shown once.
  - Friends install the desktop app, click + and enter https://$DOMAIN with an invite.
  - The certificate can take a minute. If https://$DOMAIN doesn't answer:
      cd $DIR && docker compose logs caddy
    The usual causes are a DNS record that isn't live yet, or ports 80 and 443
    not open in the provider's firewall.

  Settings:  $DIR/.env   (then: docker compose up -d)
  Logs:      cd $DIR && docker compose logs -f
  Update:    cd $DIR && docker compose pull && docker compose up -d
  Stop:      cd $DIR && docker compose down
EOF
