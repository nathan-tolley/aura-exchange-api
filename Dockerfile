FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
RUN useradd --create-home --uid 10001 aura
COPY --from=build --chown=aura:aura /app/node_modules ./node_modules
COPY --from=build --chown=aura:aura /app/dist-api ./dist-api
COPY --from=build --chown=aura:aura /app/web/dist ./web/dist
COPY --from=build --chown=aura:aura /app/package.json ./package.json
COPY --from=build --chown=aura:aura /app/db ./db
COPY --from=build --chown=aura:aura /app/uploads ./uploads
USER aura
EXPOSE 8787
CMD ["sh", "-c", "node dist-api/scripts/migrate.js && node dist-api/src/server.js"]

