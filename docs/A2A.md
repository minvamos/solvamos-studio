# SolVamos와 A2A — 무엇을 쓰고, 무엇을 쓰지 않는가

> 기준: 2026-07-26  
> 참고: [relay](https://github.com/hoddukzoa12/relay) — A2A로 협상, Solana Pay로 정산(정산 레일은 교체하지 않음)

## 한 줄 정책

**공개 커머스·정산은 gateway `invoke_url` + x402/MPP가 유일하다.**  
A2A에서는 **디스커버리용 Agent Card 형태만** 빌리고, Google A2A JSON-RPC(`message/send`)와 `@a2a-js/sdk` 서버는 **쓰지 않는다.**

Relay의 “Solana Pay is the guaranteed rail — A2A/AP2/x402 are additive”와 같은 태도다.

## 쓰는 것 (유지)

| 항목 | 위치 | 이유 |
|---|---|---|
| Discovery Agent Card | `GET /api/agents/:id/agent-card` (`server/agent-card.ts`) | 기계가 스킬·가격·`invokeUrl`을 읽기 위한 A2A-shaped JSON |
| Catalog `agent_card_url` | solvamos-catalog | 카드 URL 노출 |
| Studio 내부 peer 오케스트레이션 | `server/a2a.ts` | self → free peer → paid peer → synthesis. **제품 기능**이며 Google A2A 프로토콜이 아님 |
| Peer 결제 | vault / gateway + origin invoke | peer 간 USDC; 공개 커머스와 별개 |

## 쓰지 않는 것 (의도적 제외)

| 항목 | 이유 |
|---|---|
| `@a2a-js/sdk` / `POST /a2a/:id` JSON-RPC | 결제 모델과 충돌(유료 호출 우회·이중 레일). 외부 상호운용 수요가 생길 때까지 불필요 |
| A2A `message/send`를 공개 실행 경로로 광고 | Catalog/커머스 컨셉이 `invoke_url` 중심인데 레일이 둘로 갈라짐 |
| Peer hop을 A2A Client로 강제 교체 | 같은 Studio 내 hop은 in-process/origin invoke가 단순하고 안전 |
| x402를 A2A `securitySchemes`에 억지로 매핑 | OpenAPI security ≠ x402. 결제는 HTTP 402 on `invoke_url` |

과거 spike로 붙였던 SDK 라우트(`server/a2a-sdk-server.ts`)는 제거했다.

## 용어 정리 (혼동 방지)

| 이름 | 의미 |
|---|---|
| **Agent Card** | SolVamos 디스커버리 JSON. A2A 스펙을 *닮은* 문서. JSON-RPC 엔드포인트가 아님 |
| **invoke_url** | 유일한 공개 실행 URL. 유료면 pay-gateway |
| **Studio peer A2A** (`a2a.ts`) | Catalog peer를 고르는 **내부 오케스트레이션**. 프로토콜 준수 레이어가 아님 |
| **Google A2A Protocol** | Agent Card + `message/send` Task 모델. SolVamos는 현재 Card 형태만 부분 차용 |

## 외부 호출 경로 (고정)

```text
발견: Catalog /llms.txt · /api/v1/agents · agent_card_url
실행: invoke_url
  paid → HTTP 402 → x402/MPP USDC → gateway → Studio
  free → Studio origin POST/GET
```

## 나중에 A2A JSON-RPC를 다시 넣을 조건

다음이 **모두** 만족될 때만 재검토한다.

1. Studio 밖 에이전트가 표준 Client로 SolVamos를 호출해야 하는 구체적 파트너/유스케이스가 있다.
2. 유료 경로에 a2a-x402(또는 동등)로 정산을 붙이거나, 유료는 계속 `invoke_url`만 허용한다고 Card에 명확히 쓴다.
3. Catalog·결제·peer 오케스트레이션 문서가 이중 레일 없이 갱신된다.

그 전에는 SDK/JSON-RPC를 다시 올리지 않는다.

## 관련 코드

- Discovery card: `server/agent-card.ts`
- Peer orchestration: `server/a2a.ts`
- Commerce publish: `server/paysh-catalog.ts` → Catalog `invoke_url`
- Catalog guide: `solvamos-catalog/server/llm-discovery.ts`
