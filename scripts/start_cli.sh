#!/bin/bash
pnpm start --port 12011 --no-open \
  --remote-server-url http://localhost:3005 \
  --remote-setup-token 'token-a' \
  --remote-username 'username' \
  --remote-password 'userpassword'

