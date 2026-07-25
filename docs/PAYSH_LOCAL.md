# pay.sh gateway — Devnet

> 기준: 2026-07-26  
> **Localnet/sandbox는 폐기.** 결제는 Solana Devnet USDC + pay-gateway만 사용한다.  
> 유료 public invoke는 항상 pay-gateway를 통한다. Studio origin의 `X-PAYMENT-PROOF`는 상업 호출 경로가 아니다.

## 모드

| 모드 | `PAYMENT_NETWORK` | gateway 실행 | 자산 |
|---|---|---|---|
| Devnet | `devnet` (기본) | `pay server start pay/solvamos-provider.devnet.yml` | Devnet USDC 테스트 토큰 |

메인넷·로컬넷은 사용하지 않습니다. `PAYMENT_NETWORK=localnet|sandbox`는 부팅 시 Devnet으로 강제됩니다.

로컬 Lab에서는 `PAY_GATEWAY_MANAGED=true`가 기본이다. Studio가 Devnet pay.sh 자식 프로세스 하나를 `:1402`에서 실행한다.

- Studio 서버는 재시작되지 않는다.
- Cloud Run production에서는 managed child process가 비활성이다.

## 1회 설치

```powershell
cd solvamos-studio
npm run pay:install
# .env
# PAYMENT_NETWORK=localnet
# PAY_INTERNAL_SECRET=dev-pay-internal
# PAY_GATEWAY_MANAGED=true
# USE_PAY_GATEWAY=true
# ALLOW_LEGACY_SANDBOX_PROOF=false
```

## Localnet

```powershell
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
npm run dev

# 다른 터미널
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
.\tools\pay\pay.exe --sandbox server start pay\solvamos-provider.yml --bind 127.0.0.1:1402

.\tools\pay\pay.exe --sandbox fetch "http://127.0.0.1:1402/v1/agents/<ID>/invoke?prompt=hello"
```

## Devnet

```powershell
# Studio 사이드바에서 Devnet 선택 또는 PAYMENT_NETWORK=devnet
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
npm run dev

# 게이트웨이 — --sandbox 금지
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
.\tools\pay\pay.exe server start pay\solvamos-provider.devnet.yml --bind 127.0.0.1:1402

# 클라이언트도 --sandbox 없음 (Devnet USDC 잔고 필요)
.\tools\pay\pay.exe fetch "http://127.0.0.1:1402/v1/agents/<ID>/invoke?prompt=hello"
```

`pay setup` 후 Devnet USDC를 준비한다.

## 정식 호출 구조

```text
Catalog invoke_url
  → http://127.0.0.1:1402/v1/agents/{id}/invoke
  → HTTP 402
  → pay client 결제
  → gateway가 X-Pay-Internal-Secret을 붙여 Studio /v1/...로 proxy
  → runAgentInvoke
```

유료 agent의 Studio `/api/agents/{id}/invoke`를 직접 호출하면 실행하지 않고 gateway URL이 포함된 402를 반환한다.

gateway와 Studio는 같은 값을 사용해야 한다.

```env
PAY_INTERNAL_SECRET=dev-pay-internal
```

provider:

```yaml
routing:
  auth:
    method: header
    key: X-Pay-Internal-Secret
    value_from_env: PAY_INTERNAL_SECRET
```

## A2A

- 유료 피어: `payCurl`이 현재 모드에 따라 `--sandbox` on/off
- Localnet → sandbox CLI / Devnet → 실체인 CLI
- 무료 피어: 같은 Studio process에서 직접 RAG 호출
- legacy A2A proof는 `ALLOW_LEGACY_SANDBOX_PROOF=true`인 명시적 Lab fallback에서만 허용

## Production

별도 gateway Cloud Run을 사용한다.

```env
NODE_ENV=production
PAYMENT_NETWORK=devnet
USE_PAY_GATEWAY=true
PAY_GATEWAY_URL=https://...pay-gateway...run.app
PAY_ORIGIN_URL=https://...studio...run.app
PAY_INTERNAL_SECRET=<shared-secret>
PAY_GATEWAY_MANAGED=false
ALLOW_LEGACY_SANDBOX_PROOF=false
ALLOW_PAYMENT_BYPASS=false
```

`Dockerfile.pay-gateway`가 `pay/solvamos-provider.prod.yml`을 실행하며 boot script가 `__PAY_ORIGIN_URL__`을 치환한다.

## 알려진 제한

### 가격

현재 provider YAML은 `price_usd: 0.001`로 고정되어 있다. Agent/Catalog의 가변 `feeUsdc`와 일치시키는 동적 가격 계약이 P0 과제다. 해결 전에는 Catalog 표시 가격과 실제 gateway 청구가 다를 수 있다.

### Settlement

`PaymentSettlement` 모델과 Studio 화면은 있지만 gateway receipt를 Studio DB에 전달하는 callback/header 계약이 없다. gateway-only 거래를 완전한 ledger로 만들려면 signed receipt ingestion이 필요하다.

### Mainnet

지원하지 않는다. config는 mainnet 입력을 거부한다.
