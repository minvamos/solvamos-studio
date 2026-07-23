# pay.sh + A2A — 모드 정렬 (localnet | devnet, 메인넷 없음)

## 모드

| Studio UI | `PAYMENT_NETWORK` | pay.sh 게이트웨이 | 돈 |
|-----------|-------------------|-------------------|-----|
| **Localnet** | `localnet` (옛 `sandbox` 별칭) | `pay --sandbox server start pay/solvamos-provider.yml` | Surfpool — **실돈 없음** |
| **Devnet** | `devnet` | `pay server start pay/solvamos-provider.devnet.yml` (**`--sandbox` 없음**) | **Devnet 온체인 USDC** (faucet 테스트 토큰) |

메인넷은 사용하지 않습니다.

로컬 Lab에서는 `PAY_GATEWAY_MANAGED=true`가 기본입니다. Studio가 pay.sh 자식
프로세스 하나를 소유하며, owner/admin이 UI 모드를 누르면 기존 게이트웨이를
종료하고 같은 `:1402` 포트에 선택한 모드로 자동 기동합니다.

- Studio 서버 자체는 재시작되지 않습니다.
- 전환 중 수 초 동안 결제 요청은 실패할 수 있습니다.
- Cloud Run(`NODE_ENV=production`)에서는 자동 관리가 강제로 꺼집니다. 다중
  인스턴스의 프로세스 상태를 한 UI 요청으로 일관되게 바꿀 수 없기 때문입니다.

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

## Localnet (기본)

```powershell
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
npm run dev

# 다른 터미널
$env:PAY_INTERNAL_SECRET="dev-pay-internal"
.\tools\pay\pay.exe --sandbox server start pay\solvamos-provider.yml --bind 127.0.0.1:1402

.\tools\pay\pay.exe --sandbox fetch "http://127.0.0.1:1402/v1/agents/<ID>/invoke?prompt=hello"
```

## Devnet (온체인)

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

`pay setup` 후 Devnet USDC를 faucet 등으로 준비합니다.

## A2A

- 유료 피어: `payCurl`이 현재 모드에 따라 `--sandbox` on/off
- Localnet → sandbox CLI / Devnet → 실체인 CLI
