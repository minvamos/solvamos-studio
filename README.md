# SolVamos Studio

**SolVamos Studio**는 AI 에이전트 간(Agent-to-Agent, A2A) 거래 및 호출을 위한 초정밀 노코드 AI 에이전트 컴파일러이자 온체인 사용량 기반 배포 플랫폼입니다.

기존의 단순 챗봇 형태를 넘어, 다른 AI 에이전트나 시스템이 직접 호출하여 사용할 수 있는 전문 비즈니스 API 에이전트를 클릭 몇 번으로 즉시 빌드 및 배포할 수 있습니다. 특히 **pay.sh 프로토콜**을 적용하여 Solana Devnet 기반의 온체인 결제 검증(Paywall Block)을 거친 에이전트 호출 및 사용량 기반 과금 생태계를 완벽하게 제공합니다.

고객 **Google Workspace Drive** 문서를 Sovereign RAG로 연결하며, 고객은 GCP를 몰라도 됩니다. SolVamos Org가 고객 전용 GCP 프로젝트를 대행 운영합니다.

관련 문서: [`docs/concept.md`](../docs/concept.md) · [`docs/plan.md`](../docs/plan.md) · [`docs/progress.md`](../docs/progress.md) · [`docs/GCP_SETUP.md`](../docs/GCP_SETUP.md) · [`docs/CICD_CLOUDRUN.md`](../docs/CICD_CLOUDRUN.md)  
배포: **`main` 머지 → GitHub Actions → Cloud Run** · 비상 [`solvamos-cloudrun`](../solvamos-cloudrun) · IaC: [`infra/terraform`](../infra/terraform)

---

## 핵심 기능

### 1. 에이전트 특화 분야 (역할 군) 지정 및 커스텀 빌드
다른 AI 에이전트들이 도메인 지식이나 특정 API 해결을 위해 유료로 구독할 수 있는 전문 분야를 설정할 수 있습니다.
- **🛠️ 프로덕트 기술 지원**: 특정 프로덕트의 API 명세서, 가이드라인 제공 및 연동 트러블슈팅 지원.
- **📚 독점 학술 및 논문 데이터**: 학술 자료, 저널, 특허 문서 및 고품질 연구 분석 데이터 특화 서빙.
- **🌍 프라이빗 지리/기상 예측**: 고유 기상 시뮬레이션 및 정밀 지형/환경 분석 데이터베이스 서빙.
- **✍️ 직접 입력 (커스텀 역할)**: 사용자가 원하는 임의의 비즈니스 도메인 및 데이터 제공 규칙을 자유롭게 텍스트로 정의하여 배포.

### 2. pay.sh 온체인 페이월 프로토콜 (Solana Devnet)
- **에이전트 결제 차단막 (Paywall Block)**: 유료 에이전트 API 호출 시, 실시간으로 Solana Devnet 상에서 송금이 이루어졌는지 트랜잭션을 분석하여 검증합니다.
- **Agent-to-Agent 자동 결제 합의**: 다른 AI 에이전트가 본 에이전트의 Vertex AI RAG 컴파일 엔진을 호출할 때 필요한 요금과 수신 지갑 주소를 인식하고 검증하는 페이월 핸드셰이크 흐름을 모방/시뮬레이션합니다.

### 3. 강력한 보안 및 클라우드 아키텍처
- **GCP KMS / Secret Manager 연동**: 에이전트 생성 시 발급되는 전용 지갑의 Private Key가 노출되지 않도록 안전하게 관리(암호화 보관 흐름 구현)합니다.
- **서버사이드 RAG 연동**: Gemini API를 이용한 시스템 프롬프트 조율 및 실시간 응답 조율을 서버 단에서 처리하여 클라이언트 측 API Key 유출 위험을 원천 차단합니다.

---

## 기술 스택

- **Frontend**: React 18, Vite, Tailwind CSS, Motion (애니메이션 효과)
- **Backend**: Express, Node.js (TypeScript)
- **AI**: Gemini SDK (`@google/genai` 패키지 사용), Vertex AI Search (Discovery Engine)
- **Blockchain**: Solana Devnet (pay.sh 프로토콜 API 명세 시뮬레이션)
- **Storage & State**: 로컬 및 메모리 저장소, JSON DB 구조 동기화
- **Cloud**: GCP Secret Manager, Cloud KMS, Cloud Run (GitHub Actions CI)
- **Google APIs**: OAuth 2.0 SSO + Google Drive API (`drive.readonly`)

---

## 설치 및 로컬 구동

### 필수
- **Node.js 20+** (권장; Dockerfile도 20)
- npm

### 1. 클론 · 설치
```bash
git clone https://github.com/minvamos/solvamos-studio.git
# Lab fork: https://github.com/mikohatsu/solvamos-studio.git
cd solvamos-studio
npm install
```

### 2. 환경 변수
```bash
cp .env.example .env
```

로컬 Lab 최소 예시 (상세·금지 플래그: [`docs/DEPLOY_ENV.md`](../docs/DEPLOY_ENV.md)):

```env
GEMINI_API_KEY=
APP_URL=http://localhost:3000
PORT=3000
NODE_ENV=development

# Google SSO + Drive (필수에 가깝음 — 로그인/Drive 브라우저)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
ALLOW_ADC_DRIVE=false

GOOGLE_CLOUD_PROJECT=
TENANCY_MODE=shared
ALLOW_LOCAL_VAULT_FALLBACK=true
ALLOW_PAYMENT_BYPASS=true
PAYMENT_NETWORK=sandbox
PLATFORM_TREASURY_PUBKEY=AoUNKE8uQ8y1FEtU6YSFCsopK9veP6jZ6EGNoULjdwva
```

OAuth Web Client에 **localhost** origins/redirect를 넣어야 합니다.  
런북: [`docs/DRIVE_OAUTH_SETUP.md`](../docs/DRIVE_OAUTH_SETUP.md)

에이전트/세션 JSON은 로컬에서 `.data/` 아래(프로덕션 Cloud Run은 `/tmp/solvamos-data`)에 저장됩니다.

### 3. 개발 서버
```bash
npm run dev
```
브라우저: [http://localhost:3000](http://localhost:3000)

```bash
npm run lint    # tsc --noEmit
npm run smoke   # 서버 기동 중일 때 /api/status 등 스모크
```

### 4. 로컬 프로덕션 빌드
```bash
npm run build   # Vite + esbuild → dist/
npm start       # NODE_ENV=production 권장; PORT 기본 3000 (Cloud Run은 8080)
```

### 5. Cloud Run 배포
- **자동:** `main` 머지 → GitHub Actions → Artifact Registry → Cloud Run  
  런북: [`docs/CICD_CLOUDRUN.md`](../docs/CICD_CLOUDRUN.md)
- **수동 비상:**
```powershell
cd ../solvamos-cloudrun
.\scripts\deploy.ps1 -ProjectId "YOUR_PROJECT" -Tier "starter"
```
콘솔·시크릿·Vertex: [`docs/GCP_SETUP.md`](../docs/GCP_SETUP.md)

---

## 아키텍처 흐름도

```
[사용자 UI (SolVamos Studio)]
        │ (1) 에이전트 역할/보안/어조 설정 (예: 기술 지원)
        ▼
[백엔드 서버 (server.ts)] ──▶ [Gemini API] (프롬프트 동적 컴파일 및 컨텍스트 결합)
        │
        ├─▶ [GCP KMS 시뮬레이션] (에이전트별 Solana 전용 Private Key 암호화 보관)
        │
        ▼
[pay.sh 프로토콜 핸드셰이크]
        │ (2) 다른 에이전트의 API 호출 시도 (Status 402 Paywall Intercept)
        ▼
[On-Chain Devnet 결제 검증] ──▶ 성공 시 에이전트 답변(Vertex AI RAG 연동) 반환
```

런타임 분리 (확정):
- **Cloud Run** = x402 결제 대문 (HTTP 402)
- **Vertex AI Search + Gemini** = RAG 뇌
- Drive 원본 = 고객 Google Workspace (플랫폼 Drive 미사용)

---

## 라이선스

This project is licensed under the MIT License.
