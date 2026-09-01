# AI Research Workbench 한국어 안내

[원문 README](../../README.md)에서 전체 아키텍처, 운영 절차와 제한 사항을 확인할 수 있습니다.

## 목적

AI Research Workbench v0.2.0은 범위가 정해진 조사 brief를 검토 가능한 승인 기반 산출물로 만드는 로컬 evidence-first 작업 공간입니다. source → evidence → claim → finding → deliverable 연결을 보존하고, 결정적 QA와 명시적인 운영자 결정을 기록합니다.

## 빠른 시작

Node.js 22.13 이상, npm, Docker Compose 또는 별도 PostgreSQL 17이 필요합니다.

```bash
npm ci
npm run setup
npm run operator:create
npm run dev:all
```

`http://localhost:3100`을 열고 생성한 운영자로 로그인한 뒤 synthetic `project-demo` fixture를 선택합니다. `dev:all`은 web과 durable worker를 함께 시작합니다.

## 주요 기능

- 조사 계획, source, evidence, claim, finding과 deliverable provenance
- 업로드 문서 quarantine, malware scan, bounded extraction과 citation anchor
- PostgreSQL 작업 큐를 통한 11단계 조사 pipeline
- conflict/gap 탐지, deterministic QA, 사람 승인 gate와 audit event
- Markdown, HTML, PDF, DOCX, CSV와 승인된 ZIP export
- private local 또는 S3-compatible object storage의 크기·SHA-256 무결성 검증
- deterministic mock AI/search provider와 선택적 live provider canary

## 설정과 운영 안전

- 기본 mock provider 경로는 API key가 필요 없으며 일반 테스트는 live network를 사용하지 않습니다.
- 작업 큐는 at-least-once 전달이며 exactly-once 실행이 아닙니다. 새 효과는 replay-safe해야 합니다.
- 현재 인증은 로컬 운영자를 위한 최소 경계이며 role 권한, tenant 격리 또는 public multi-tenant 배포를 제공하지 않습니다.
- `.env`, provider credential, 고객 조사, 비공개 URL, runtime storage와 delivery bundle을 커밋하지 마십시오.
- live provider는 외부 데이터 전송과 비용이 발생할 수 있으며 mock 성공은 실제 조사 정확도나 live 호환성의 증거가 아닙니다.
- production에서는 인증, secure cookie, 충분한 session secret과 fail-closed ClamAV가 필요하지만 이것만으로 TLS, backup, retention 또는 tenancy가 해결되지는 않습니다.

## 검증

```bash
npm run docs:validate
npm run test:unit
npm run typecheck
npm run lint
npm run build
```

전체 Vitest와 production build를 포함한 gate는 `npm run verify`, 브라우저 동작은 별도로 `npm run test:e2e`를 사용합니다. 데이터베이스 테스트는 이름에 `test`가 포함된 `TEST_DATABASE_URL`만 허용합니다.
