# dam-authenticate

## Purpose
Authenticate with The Dam API and store the JWT token for all subsequent skill calls. Re-run automatically whenever a 401 is received.

## Trigger
- On OpenClaw startup
- Whenever any Dam API call returns HTTP 401
- Every 6 days (tokens expire in 7 days)

## Environment Variables Required
```
DAM_URL=https://app.beaver.solutions
DAM_EMAIL=admin@beaversolutions.com
DAM_PASSWORD=[stored as OpenClaw secret]
```

## Steps

1. Send POST request:
   ```
   POST {DAM_URL}/api/auth/login
   Content-Type: application/json

   {
     "email": "{DAM_EMAIL}",
     "password": "{DAM_PASSWORD}"
   }
   ```

2. On success (HTTP 200):
   - Extract `data.token` from the response
   - Store as session variable: `DAM_TOKEN`
   - Extract `data.user.client.name` → store as `DAM_CLIENT_NAME`
   - Log: "Authenticated with The Dam as {DAM_EMAIL}"

3. On failure (HTTP 401 or 400):
   - Send Telegram alert: "⚠️ The Dam login failed. Check credentials."
   - Stop execution — do not proceed with other skills

## Usage in Other Skills
All subsequent API calls must include:
```
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json
```

If any call returns 401, call dam-authenticate first then retry once.
