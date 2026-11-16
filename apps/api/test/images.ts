// Testcontainers images, pinned by digest (conventions §9). Keep them identical to docker-compose.yml; Dependabot
// updates the compose file, so bump these together with it.
export const POSTGRES_IMAGE =
  'postgres:18-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015';
export const REDIS_IMAGE = 'redis:8-alpine@sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3';
export const MINIO_IMAGE =
  'cgr.dev/chainguard/minio:latest@sha256:18c8fa28697b25e0f34c6faae171079e88a03efb8e76a21d3b5d07b4e3cbef3e';
