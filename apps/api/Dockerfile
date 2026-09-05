# OSAS reference API (@osas/api).
# Build context MUST be the repository root (this is a pnpm workspace image).
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
COPY schemas ./schemas

RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production \
    PORT=3001 \
    SEED_DEMO=true \
    MODEL_PROVIDER=mock

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]
