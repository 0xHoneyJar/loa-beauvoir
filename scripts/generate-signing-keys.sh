#!/usr/bin/env bash
#
# generate-signing-keys.sh - Generate Ed25519 signing keys for Loa
#
# Generates a 32-byte Ed25519 private key and derives the public key.
# Output is hex-encoded for storage in environment variables or Cloudflare Secrets.
#
# Usage:
#   ./scripts/generate-signing-keys.sh [--env] [--cloudflare]
#
# Options:
#   --env         Output in .env format
#   --cloudflare  Output wrangler secret commands
#   --json        Output in JSON format
#
# Security:
#   - Keys are generated using /dev/urandom (CSPRNG)
#   - Never commit private keys to version control
#   - Store in Cloudflare Secrets for production
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for required tools
check_dependencies() {
  local missing=()

  if ! command -v openssl &> /dev/null; then
    missing+=("openssl")
  fi

  if ! command -v xxd &> /dev/null; then
    missing+=("xxd")
  fi

  if [ ${#missing[@]} -ne 0 ]; then
    echo -e "${RED}Error: Missing required tools: ${missing[*]}${NC}" >&2
    echo "Install with: apt-get install openssl xxd (or brew install openssl)" >&2
    exit 1
  fi
}

# Generate Ed25519 key pair
generate_keypair() {
  # Generate 32-byte private key
  local private_key_hex
  private_key_hex=$(openssl rand -hex 32)

  # For Ed25519, we need to derive the public key from the private key
  # Using openssl's Ed25519 support (requires OpenSSL 1.1.1+)

  # Create a temporary PEM file
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  local priv_pem="$tmpdir/private.pem"
  local pub_pem="$tmpdir/public.pem"

  # Convert hex to binary and create Ed25519 private key
  echo "$private_key_hex" | xxd -r -p > "$tmpdir/seed.bin"

  # Generate the key pair using the seed
  # OpenSSL Ed25519 expects the seed in a specific format
  # We'll use a different approach: generate fresh key pair
  openssl genpkey -algorithm Ed25519 -out "$priv_pem" 2>/dev/null
  openssl pkey -in "$priv_pem" -pubout -out "$pub_pem" 2>/dev/null

  # Extract the raw private key (32 bytes)
  # Ed25519 private key in PKCS#8 format has the seed at a specific offset
  local raw_private
  raw_private=$(openssl pkey -in "$priv_pem" -text 2>/dev/null | grep -A 3 "priv:" | tail -n 3 | tr -d ' \n:')

  # Extract the raw public key (32 bytes)
  local raw_public
  raw_public=$(openssl pkey -in "$priv_pem" -text_pub 2>/dev/null | grep -A 2 "pub:" | tail -n 2 | tr -d ' \n:')

  # If extraction failed, use alternative method
  if [ -z "$raw_private" ] || [ -z "$raw_public" ]; then
    # Fallback: generate using node if available
    if command -v node &> /dev/null; then
      local result
      result=$(node -e "
        const { randomBytes } = require('crypto');
        const seed = randomBytes(32);
        console.log(JSON.stringify({
          private: seed.toString('hex'),
          public: 'GENERATE_WITH_NODE'
        }));
      ")
      raw_private=$(echo "$result" | grep -o '"private":"[^"]*"' | cut -d'"' -f4)

      # We'll output a note that public key needs derivation
      echo -e "${YELLOW}Note: Public key derivation requires noble/ed25519 library${NC}" >&2
      echo -e "${YELLOW}Run: node -e \"import('@noble/ed25519').then(ed => ed.getPublicKey(Buffer.from('$raw_private', 'hex')).then(k => console.log(Buffer.from(k).toString('hex'))))\"${NC}" >&2
      raw_public="<derive-with-noble-ed25519>"
    else
      echo -e "${RED}Error: Could not extract keys. Install Node.js for Ed25519 support.${NC}" >&2
      exit 1
    fi
  fi

  echo "$raw_private|$raw_public"
}

# Compute key ID (first 8 bytes of SHA-256 of public key)
compute_key_id() {
  local public_key_hex="$1"
  echo -n "$public_key_hex" | xxd -r -p | openssl dgst -sha256 -binary | xxd -p -l 8
}

# Main
main() {
  local output_format="plain"

  while [[ $# -gt 0 ]]; do
    case $1 in
      --env)
        output_format="env"
        shift
        ;;
      --cloudflare)
        output_format="cloudflare"
        shift
        ;;
      --json)
        output_format="json"
        shift
        ;;
      -h|--help)
        echo "Usage: $0 [--env] [--cloudflare] [--json]"
        echo ""
        echo "Generate Ed25519 signing keys for Loa identity verification."
        echo ""
        echo "Options:"
        echo "  --env         Output in .env format"
        echo "  --cloudflare  Output wrangler secret commands"
        echo "  --json        Output in JSON format"
        exit 0
        ;;
      *)
        echo -e "${RED}Unknown option: $1${NC}" >&2
        exit 1
        ;;
    esac
  done

  check_dependencies

  echo -e "${GREEN}Generating Ed25519 signing keys...${NC}" >&2

  local keypair
  keypair=$(generate_keypair)

  local private_key
  local public_key
  private_key=$(echo "$keypair" | cut -d'|' -f1)
  public_key=$(echo "$keypair" | cut -d'|' -f2)

  local key_id=""
  if [ "$public_key" != "<derive-with-noble-ed25519>" ]; then
    key_id=$(compute_key_id "$public_key")
  fi

  case $output_format in
    env)
      echo ""
      echo "# Loa Ed25519 Signing Keys"
      echo "# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
      [ -n "$key_id" ] && echo "# Key ID: $key_id"
      echo "LOA_SIGNING_KEY=$private_key"
      echo "LOA_PUBLIC_KEY=$public_key"
      ;;
    cloudflare)
      echo ""
      echo "# Store keys in Cloudflare Secrets"
      echo "# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
      [ -n "$key_id" ] && echo "# Key ID: $key_id"
      echo ""
      echo "echo '$private_key' | wrangler secret put LOA_SIGNING_KEY"
      echo "echo '$public_key' | wrangler secret put LOA_PUBLIC_KEY"
      ;;
    json)
      echo "{"
      echo "  \"keyId\": \"$key_id\","
      echo "  \"privateKey\": \"$private_key\","
      echo "  \"publicKey\": \"$public_key\","
      echo "  \"algorithm\": \"ed25519\","
      echo "  \"generated\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\""
      echo "}"
      ;;
    plain|*)
      echo ""
      echo "═══════════════════════════════════════════════════════════════"
      echo "  Loa Ed25519 Signing Keys"
      echo "═══════════════════════════════════════════════════════════════"
      echo ""
      [ -n "$key_id" ] && echo "  Key ID:      $key_id"
      echo "  Generated:   $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
      echo ""
      echo "  Private Key (KEEP SECRET!):"
      echo "  $private_key"
      echo ""
      echo "  Public Key:"
      echo "  $public_key"
      echo ""
      echo "═══════════════════════════════════════════════════════════════"
      echo ""
      echo -e "${YELLOW}⚠️  SECURITY WARNINGS:${NC}"
      echo "  • Never commit the private key to version control"
      echo "  • Store in Cloudflare Secrets for production"
      echo "  • Keep a secure backup of the private key"
      echo "  • Rotate keys every 90 days"
      echo ""
      ;;
  esac
}

main "$@"
