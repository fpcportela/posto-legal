# vps-infra — shared Hostinger VPS `srv1516192`

## 2. The shared edge — `omniform` nginx

Prosa que o parser deve ignorar.

## 4. Host-gateway port registry (`172.17.0.1:<port>`)

Claim a port here **before** using it.

| Port | App | Service | Notes |
|------|-----|---------|-------|
| 80 / 443 | omniform | `omniform_nginx` | shared public edge — do not rebind |
| 3000 | omniform | `frontend` | omniform network (by-name) |
| 3100 | omni-chat | `api` | host-gateway (REST + socket.io) |
| 8090 | omni-chat | `web` | host-gateway (static SPA + widget) |
| 3212 | riosbraz.com.br | `web` (nginx static) | host-gateway; deployed 2026-07-15 |
| 3213 | trabalhista | `web` (Next.js) | host-gateway; deployed 2026-07-15 |

> Free ranges for new apps: `3212+`, `8100+`. Add your row when you claim one.

---

## 5. Rules & hazards

- **Never bind app ports to `0.0.0.0` or 80/443.** Use `172.17.0.1:<port>`.
- **Every container needs a memory limit.**

---

## 11.3 Policy going forward

| Class | Suggested limit | Examples |
|-------|-----------------|----------|
| Static/nginx | 128M | `*-web` (static) |
| Redis | 128M + `maxmemory` | `*-redis` |
