# OSAS web console (@osas/web).
# Build context MUST be the repository root (this is a pnpm workspace image).
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY schemas ./schemas

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @osas/web build

FROM nginx:alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
