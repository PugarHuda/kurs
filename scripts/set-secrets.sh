#!/usr/bin/env bash
# Puts the testnet reporter/deployer keys from .env where the hosted parts of Kurs need them:
#   - Vercel (production env): api/bundle signs live bundles for ERC-7412 pull clients
#   - GitHub Actions secrets: .github/workflows/relay.yml pushes rounds every 10 minutes
# Run from the repo root: bash scripts/set-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
get() { grep "^$1=" .env | cut -d= -f2; }
for i in 1 2 3 4 5; do
  k="REPORTER_${i}_PK"
  printf "%s" "$(get "$k")" | npx -y vercel@latest env add "$k" production --force >/dev/null && echo "vercel: $k"
  gh secret set "$k" --repo PugarHuda/kurs --body "$(get "$k")" && echo "github: $k"
done
gh secret set DEPLOYER_PK --repo PugarHuda/kurs --body "$(get DEPLOYER_PK)" && echo "github: DEPLOYER_PK"
gh variable set KURS_CHAINS --repo PugarHuda/kurs --body "sepolia" && echo "github var: KURS_CHAINS=sepolia"
npx -y vercel@latest deploy --prod --yes >/dev/null && echo "vercel: redeployed with keys"
