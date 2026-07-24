# SolVamos API Surface

> 기준: 2026-07-25. 상세 request/response type의 단일 OpenAPI spec은 아직 없다.

## Studio health/status

- `GET /healthz`: process health
- `GET /readyz`: readiness
- `GET /api/status`: auth, GCP, payment, Catalog, gateway runtime status
- `GET /v1/health`: gateway upstream-compatible Studio health

## Auth/account

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/auth/google?intent=login|signup|link`
- `GET /api/auth/google/callback`
- `GET /api/account/me`

Auth는 HttpOnly cookie를 사용한다. mutation과 owner data 요청은 `credentials: include`가 필요하다.

## Tenant

- `GET /api/tenants`
- `GET /api/tenants/plan/preview`
- `POST /api/tenants`
- `GET /api/tenants/:id`
- `PATCH /api/tenants/:id`
- `POST /api/tenants/:id/cloud-run`
- `POST /api/tenants/provision-lab`

일부 tenant route의 authorization은 product 수준으로 통일되지 않았다. 현재 shared Lab 운영을 전제로 하며 production isolated tenant API로 간주하면 안 된다.

## Drive

- `GET /api/drive/folders?parent=root&foldersOnly=0`

Google Drive OAuth token이 server-side session에 있어야 한다.

## Agent

- `GET /api/agents`
- `GET /api/ai-applications/catalog`
- `POST /api/agents/create`
- `PATCH /api/agents/:id`
- `POST /api/agents/preview-prompt`
- `GET /api/agents/:id/balance`
- `POST /api/agents/:id/invoke`
- `GET /api/agents/:id/agent-card`
- `GET /.well-known/agent/:id.json`
- `GET /.well-known/agent.json`

현재 public delete route는 없다. create rollback에서만 내부 `deleteAgent`가 사용된다.

### Create request 핵심 필드

```json
{
  "agentName": "Support Agent",
  "role": "support",
  "customRole": "",
  "tone": "professional",
  "securityLevel": "strict",
  "fee": 0.001,
  "aiAppType": "search_docs",
  "dataSourceType": "local_upload",
  "googleDriveFolderId": null,
  "websiteUri": null,
  "localFiles": []
}
```

응답에는 Agent, vault public key, Datastore/Engine ID, 생성 pipeline, Catalog URL이 포함된다.

### Owner invoke

```json
{
  "prompt": "질문",
  "studioTest": true,
  "enableA2A": false,
  "history": [
    { "role": "user", "text": "이전 질문" },
    { "role": "model", "text": "이전 답변" }
  ],
  "answerSession": "projects/.../sessions/...",
  "webSearch": false,
  "attachments": [
    {
      "name": "diagram.png",
      "mimeType": "image/png",
      "dataBase64": "..."
    }
  ]
}
```

owner test는 로그인 사용자에게 agent membership 또는 ownership이 있어야 한다.

### Invoke success 핵심 필드

```json
{
  "status": "success",
  "answer": "...",
  "confidence": 0.95,
  "citations": [],
  "ragMode": "ai_application",
  "generation": "ai_application_answer",
  "engineId": "...",
  "dataStoreId": "...",
  "session": "...",
  "relatedQuestions": [],
  "toolsUsed": ["engine_answer"],
  "a2a": {
    "catalogUsed": false,
    "peerHops": []
  }
}
```

### Paid direct-origin response

유료 외부 client가 Studio origin을 직접 호출하면 실행하지 않고 402를 반환한다.

```json
{
  "status": "payment_required",
  "protocol": "x402 / MPP",
  "amount": 0.001,
  "token": "USDC",
  "invokeUrl": "https://<gateway>/v1/agents/<id>/invoke"
}
```

## Gateway internal invoke

- `GET /v1/agents/:agentId/invoke?prompt=...`
- `POST /v1/agents/:agentId/invoke`
- `POST /api/internal/agents/:id/invoke`

필수 header:

```http
X-Pay-Internal-Secret: <shared secret>
```

이 경로는 gateway가 결제를 완료한 후 origin을 호출하기 위한 것이다. public client용이 아니다.

## Wallet

- `GET /api/wallets`
- `POST /api/wallets`
- `POST /api/wallets/:id/primary`
- `PATCH /api/wallets/:id`
- `DELETE /api/wallets/:id`

## Settlement

- `GET /api/settlements`

현재 gateway receipt ingestion이 연결되지 않아 완전한 ledger API가 아니다.

## Payment mode

- `GET /api/payment/network`
- `POST /api/payment/network`

runtime 변경은 development 전용이며 production에서는 차단된다.

## Studio Catalog compatibility

- `GET /api/catalog`
- `GET /api/paysh/catalog` (deprecated alias)
- `GET /api/catalog/mode`
- `POST /api/catalog/:agentId/register`

Studio `/catalog` HTML route는 별도 Catalog marketplace로 redirect한다.

## Catalog service

Public:

- `GET /health`
- `GET /api/catalog`
- `GET /api/catalog/:agentId`
- `GET /api/solvamos/:agentId`
- `GET /api/solvamos/:agentId/index.md`

Admin:

- `POST /api/catalog/agents`
- `POST /api/catalog/agents/bulk`
- `DELETE /api/catalog/agents/:agentId`
- `POST /api/catalog/agents/:agentId/unlist`

자세한 계약은 [CATALOG_INTEGRATION.md](./CATALOG_INTEGRATION.md)를 참고한다.

## 후속 API 작업

- OpenAPI 3 spec 생성
- runtime DTO를 Studio/Catalog shared package로 분리
- 일관된 error code/request ID
- route별 authorization matrix test
- pagination
- signed gateway receipt endpoint
- conversation/thread persistence API
