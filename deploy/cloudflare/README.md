# Loa Cloud Stack - Cloudflare Deployment

## Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com/) with Workers Paid plan ($5/month)
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
3. Anthropic API key

## Quick Start

### 1. Install Dependencies

```bash
cd deploy/cloudflare
npm install
```

### 2. Create R2 Bucket

```bash
npm run r2:create
```

### 3. Configure Secrets

Required:
```bash
npm run secret:anthropic    # Anthropic API key
```

R2 Persistence (required for state to survive restarts):
```bash
npm run secret:r2-key       # R2 access key ID
npm run secret:r2-secret    # R2 secret access key
npm run secret:cf-account   # Cloudflare account ID
```

Optional - Gateway Auth:
```bash
npm run secret:gateway      # Or use device pairing
```

Optional - Messaging Channels:
```bash
npm run secret:telegram     # Telegram bot token
npm run secret:discord      # Discord bot token
npm run secret:slack-bot    # Slack bot token
npm run secret:slack-app    # Slack app token
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Verify

```bash
# Check deployment
npm run tail

# Access admin UI
# https://loa-beauvoir.<your-subdomain>.workers.dev/admin
```

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `GATEWAY_TOKEN` | No | Gateway auth token |
| `R2_ACCESS_KEY_ID` | Yes* | R2 access key |
| `R2_SECRET_ACCESS_KEY` | Yes* | R2 secret key |
| `CF_ACCOUNT_ID` | Yes* | Cloudflare account ID |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `AI_GATEWAY_BASE_URL` | No | Custom AI Gateway URL |

*Required for state persistence

## Getting R2 Credentials

1. Go to Cloudflare Dashboard → R2 → Manage R2 API Tokens
2. Create new token with:
   - Object Read & Write permissions
   - Apply to bucket: `loa-beauvoir-data`
3. Copy Access Key ID and Secret Access Key

## Cloudflare Access (Optional)

To protect the admin UI with SSO:

1. Go to Cloudflare Zero Trust
2. Create an Access Application for your Workers URL
3. Configure the secrets:
   ```bash
   wrangler secret put CF_ACCESS_TEAM_DOMAIN
   wrangler secret put CF_ACCESS_AUD
   ```

## Troubleshooting

### Container not starting
- Check logs: `npm run tail`
- Verify ANTHROPIC_API_KEY is set
- Check container instance type (standard-4 has 4GB RAM)

### R2 not persisting
- Verify all R2 secrets are set
- Check R2 bucket exists: `npm run r2:list`
- Verify bucket name in wrangler.toml matches

### Gateway not responding
- Check container is running in Cloudflare dashboard
- Verify no port conflicts
- Check gateway token if using auth

## Development

```bash
# Run locally with wrangler
npm run dev

# Watch logs
npm run tail
```

## Costs

- Workers Paid: $5/month
- R2: ~$0.015/GB/month storage, $0.36/million requests
- Containers: Included in Workers Paid (standard-4 instance)
