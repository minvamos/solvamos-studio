# Deployment note

현재 repository에는 세 서비스 중 Studio와 pay-gateway 이미지 정의가 있다.

- Studio: `Dockerfile`, `cloudbuild.studio.yaml`
- pay-gateway: `Dockerfile.pay-gateway`, `cloudbuild.pay-gateway.yaml`
- Catalog: 별도 `solvamos-catalog` repository

Cloud Build YAML은 Artifact Registry image build/push까지만 정의한다. Cloud Run service 생성·업데이트, 환경 변수, Secret Manager 연결, Cloud SQL 연결은 CI 또는 별도 `gcloud run deploy` 단계가 담당한다.

필수 배포 순서와 smoke check는 [`docs/PROCESSES.md`](../docs/PROCESSES.md#11-배포), 전체 토폴로지는 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)를 참고한다.
