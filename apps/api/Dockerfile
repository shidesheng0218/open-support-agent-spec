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

# Generate the compat report inside the image so /v1/compat/report serves a
# report produced by THIS build (the report directory is git-ignored).
# A failing compat suite fails the image build — releases must be green.
RUN pnpm --filter @osas/compat-suite test

# Milestone 2: demo auth fails closed under NODE_ENV=production. This image
# is the reference DEMO, so it ships NODE_ENV=demo + OSAS_AUTH_MODE=demo.
# Real deployments must set NODE_ENV=production and OSAS_AUTH_MODE=jwt with
# OSAS_JWKS_URL / OSAS_JWT_ISSUER / OSAS_JWT_AUDIENCE.
ENV NODE_ENV=demo \
    PORT=3001 \
    SEED_DEMO=true \
    MODEL_PROVIDER=mock \
    OSAS_AUTH_MODE=demo \
    OSAS_STORAGE=memory \
    OSAS_LLM_PROVIDER=mock \
    OSAS_EXECUTION_MODE=shadow

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]
