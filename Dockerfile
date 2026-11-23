# syntax=docker/dockerfile:1.7
# One image recipe for every service:  docker build --build-arg SERVICE=api-gateway .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE=<app> is required" && exit 1)
RUN pnpm --filter "@zk-sla/${SERVICE}" deploy --prod --legacy /out

FROM node:${NODE_VERSION}-slim AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE_NAME=${SERVICE}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/index.js"]
