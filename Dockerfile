# Prash & Ki commerce API.
#
# Standalone repository, so the build context is this repository root:
#
#   docker build -t prashki-backend .

# ---------------------------------------------------------------- deps
FROM node:22-alpine AS deps
# Prisma's query engine needs OpenSSL; without it you get a cryptic
# "Unable to require libquery_engine" at runtime rather than at build time.
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
# The schema must be present before `npm ci`: the postinstall hook runs
# `prisma generate`, which fails without it. Copying it here also means the
# generated client is cached in this layer and only rebuilt when the schema or
# the lockfile changes.
COPY prisma ./prisma
RUN npm ci

# --------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx prisma generate
RUN npx tsc -p tsconfig.json

# -------------------------------------------------------------- runner
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# node_modules is carried over whole: the Prisma CLI is needed at start-up to
# run migrations, and the generated client lives in there too.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/data ./data
# The seed is TypeScript and imports from src/, so the source is needed to run
# it inside the container (`npx tsx prisma/seed.ts`). The server never uses it.
COPY --from=build /app/src ./src

# The local storage provider writes here. Mount a volume over it in production,
# or switch STORAGE_PROVIDER to s3/r2 — otherwise uploads die with the container.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
VOLUME ["/app/uploads"]

USER node
EXPOSE 4000

# Migrations run before the server accepts traffic. `migrate deploy` only applies
# committed migrations — it never generates or resets anything.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
