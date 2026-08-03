# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The Prisma schema must be present before install so `prisma generate`
# (run explicitly below, since package.json has no postinstall side effects
# we want during a production install) has something to read.
COPY prisma ./prisma
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the client into node_modules. Without this @prisma/client is an
# unusable stub and both the build and the server fail at runtime.
RUN npx prisma generate
RUN npm run build

FROM node:24-alpine AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY package.json package-lock.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
# The schema and migrations are needed at runtime to apply pending migrations.
COPY --from=build /app/prisma ./prisma

# Writable location for the SQLite file when no external database is provided.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATABASE_URL="file:/app/data/prod.db"

USER node
EXPOSE 3000

# Apply migrations before serving so a fresh volume gets a valid schema.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
